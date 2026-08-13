// Handler /stream — le coeur de l'addon.
//
// Sequence : identite -> fan-out sous budget -> dedup -> tri -> mise en forme.
// Aucun debridage ici (cf. debrid/token.ts pour le pourquoi).

import type { Request, Response } from 'express';
import { parseConfig, nomLangue } from '../core/config';
import { parseStremioId } from '../core/ids';
import { resolveWork, estAsiatique } from '../core/meta';
import { searchAll } from '../core/registry';
import { getSettings } from '../core/settings';
import { langOrderFromSubs } from '../core/prefs';
import { comparer, passeFiltres, type EtatFlux } from '../core/filters';
import { toStremioStream, type StremioStream, type PisteFlux } from '../core/display';
import { getBaseUrl } from '../core/url';
import { encodeToken } from '../debrid/token';
import { cacheParService, resolve, type NomDebrid } from '../debrid/resolver';
import { languesDuFichier, languesDejaConnues } from '../core/pistes-fichier';
import { noterRequete } from '../core/metrics';
import { prechauffer } from './subtitles';
import { marquerMort } from '../debrid/deadlinks';
import { cached } from '../core/cache';
import { isRedirector, infosLiens, type InfoLien } from '../debrid/alldebrid';
import { throughMediaflow } from '../core/mediaflow';
import type { Candidate, MediaType, Query } from '../sources/types';

/**
 * Deduplication.
 *
 * Deux trackers renvoient tres souvent la meme release : sans ca, l'utilisateur voit
 * quatre fois la meme ligne. On dedoublonne sur le hash pour les torrents (identite
 * exacte) et sur l'URL pour le reste.
 */
function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = c.infoHash
      ? `h:${c.infoHash.toLowerCase()}`
      : c.directUrl
        ? `u:${c.directUrl}`
        : c.ddlUrl
          ? `d:${c.ddlUrl}`
          : `t:${c.sourceId}:${c.title}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, c);
      continue;
    }
    // Doublon : on garde celui qui porte le plus d'information (seeders connus,
    // taille connue) plutot que le premier arrive.
    const score = (x: Candidate) => (x.seeders ?? 0) + (x.sizeBytes ? 1 : 0);
    if (score(c) > score(existing)) seen.set(key, c);
  }
  return [...seen.values()];
}

/**
 * Combien de fichiers on accepte d'ouvrir pour connaitre leurs pistes.
 *
 * Chacun coute une resolution chez le debrideur et une requete Range. Six suffisent :
 * ce sont les entrees de tete, celles qu'on regarde. Le resultat etant memorise sur le
 * hash, les recherches suivantes sur le meme titre n'en paient aucune.
 */
const MAX_MESURES = 6;

function buildQuery(
  type: MediaType,
  parsed: NonNullable<ReturnType<typeof parseStremioId>>,
  work: { titles: string[]; year?: number; originalLanguage?: string; imdbId?: string; tmdbId?: string; kkhId?: string },
): Query {
  return {
    type,
    imdbId: work.imdbId ?? (parsed.kind === 'imdb' ? parsed.value : undefined),
    tmdbId: work.tmdbId ?? (parsed.kind === 'tmdb' ? parsed.value : undefined),
    kkhId: work.kkhId ?? (parsed.kind === 'kkh' ? parsed.value : undefined),
    titles: work.titles,
    year: work.year,
    season: parsed.season,
    episode: parsed.episode,
    originalLanguage: work.originalLanguage,
  };
}

export async function handleStream(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const config = parseConfig((req.params as Record<string, string>).config);
  const type = req.params.type === 'movie' ? 'movie' : 'series';
  const parsed = parseStremioId(req.params.id);

  // Un id qu'on ne sait pas lire est un cas NORMAL (l'utilisateur navigue dans un
  // catalogue qu'on ne couvre pas) : liste vide, jamais une erreur.
  if (!parsed) {
    res.json({ streams: [] });
    return;
  }

  try {
    const work = await resolveWork(parsed, type, config);
    if (!work) {
      // Identite introuvable : aucune source ne peut chercher sans titre. On le TRACE,
      // sinon ce cas est indiscernable d'une recherche qui n'a rien trouve — la
      // reponse est la meme liste vide, et le journal restait muet. C'est ce qui m'a
      // fait suspecter les sources alors que l'identifiant demande n'existait pas.
      console.log(`[Stream] ${req.params.type}/${req.params.id} -> identite non resolue (aucune fiche)`);
      res.json({ streams: [] });
      return;
    }

    // Hors creneau : on s'arrete AVANT d'interroger la moindre source. Repondre une
    // liste vide apres avoir scrape et depose des magnets ne servirait personne.
    if (!estAsiatique(work)) {
      console.log(`[Perimetre] ${req.params.id} hors creneau (${work.country ?? work.originalLanguage ?? '?'})`);
      res.json({ streams: [] });
      return;
    }

    const query = buildQuery(type, parsed, work);
    // Chronometrage par PHASE. Le detail par source ne disait qu'une partie de
    // l'histoire : sur une mesure a 14,9 s, le fan-out n'en representait que 5,6 —
    // les deux tiers se depensaient APRES, sans que rien ne le montre.
    const phases: Record<string, number> = {};
    const chrono = async <T>(nom: string, f: () => Promise<T>): Promise<T> => {
      const t = Date.now();
      try {
        return await f();
      } finally {
        phases[nom] = Date.now() - t;
      }
    };

    const settings = getSettings();
    /** Millisecondes restantes avant le plafond dur de la reponse. */
    const restant = (): number => settings.reponseMaxMs - (Date.now() - started);

    // Le fan-out ne peut pas manger tout le budget : il faut qu'il reste de quoi
    // enrichir. Deux tiers pour chercher, un tiers pour qualifier — la repartition
    // vient de la mesure, ou l'enrichissement coutait autant que la recherche.
    const { candidates, timings, apports, timedOut } = await chrono('fanout', () =>
      searchAll(query, config, Math.max(1500, Math.round(restant() * 0.66))),
    );
    const langOrder = langOrderFromSubs(config.subLangs);

    // Episodes de la saison demandee. Sert AU FILTRE (juger un pack a l'episode) comme
    // a l'AFFICHAGE (annoncer le poids d'un episode) : declare une seule fois, tot,
    // pour que les deux disent la meme chose.
    const episodesSaison =
      parsed.season !== undefined ? work.episodesParSaison?.[parsed.season] : undefined;
    const deduplique = dedupe(candidates);

    // Ce qu'on a appris des fichiers lors des recherches precedentes. Lecture pure, sans
    // reseau : elle doit avoir lieu AVANT le filtrage, sinon le filtre « ecarter ce qui
    // n'a pas de francais » ignorerait tout ce qu'on sait deja.
    for (const c of deduplique) {
      if (!c.languesIntegrees) {
        const su = languesDejaConnues(c.infoHash);
        if (su) c.languesIntegrees = su;
      }
    }


    // ETAT DU CACHE, avant le tri.
    //
    // Mesure qui a impose ce code : sur un episode, 0 des 15 torrents affiches
    // etaient en cache TorBox, et seulement la moitie disponibles chez AllDebrid.
    // Autrement dit, un flux sur deux echouait au Play apres ~10 s d'attente.
    //
    // TorBox repond par LOT, en une requete : c'est assez rapide pour tenir dans le
    // budget. AllDebrid n'expose plus rien d'equivalent — ses entrees restent donc
    // marquees « a debrider », sans jamais affirmer une disponibilite inconnue.
    const hashes = deduplique.map((c) => c.infoHash).filter((h): h is string => Boolean(h));

    // ETAT DES LIENS DDL, en UNE requete pour tous.
    //
    // Mesure sur un episode : 6 des 22 liens DDL proposes etaient DEJA MORTS chez
    // l'hebergeur. Chaque clic dessus etait une erreur garantie, apres l'attente du
    // debridage. `link/infos` accepte un lot et rend un verdict par lien — le cout est
    // donc d'une requete, pas d'une par lien.
    //
    // Les redirecteurs en sont exclus : ils masquent l'hebergeur, `link/infos` ne peut
    // rien en dire. Ils restent parfaitement exploitables par `/link/redirector`, qui
    // est le chemin que la resolution emprunte pour eux.
    const liensAVerifier = deduplique
      .filter((c) => c.kind === 'ddl' && c.ddlUrl && !isRedirector(c.ddlUrl))
      .map((c) => c.ddlUrl as string);

    // Le cache serialise en JSON : une Map y perd son type et revient en objet nu.
    // On memorise donc des PAIRES, et on reconstruit la Map a la sortie. Le defaut ne
    // se voyait pas au premier appel — seulement au second, quand le cache repondait.
    // LES DEUX ENRICHISSEMENTS EN PARALLELE, sous ce qui reste du plafond.
    //
    // Ils s'executaient l'un APRES l'autre, alors qu'ils sont totalement independants :
    // l'un interroge les debrideurs sur des hashes, l'autre sur des liens d'hebergeur.
    // Mesure avant correction : 3659 ms puis 3219 ms, soit 6,9 s ajoutees a un fan-out
    // qui en avait deja pris 5,9.
    //
    // Ce qui n'a pas le temps de se faire est OMIS, pas attendu. Une etiquette
    // manquante degrade la liste ; une reponse qui n'arrive pas la supprime.
    const budgetEnrichissement = Math.max(0, restant() - 400);

    const [enCache, paires] = await chrono('enrichissement', () =>
      Promise.all([
        hashes.length > 0 && budgetEnrichissement > 500
          ? cacheParService(hashes, config, AbortSignal.timeout(budgetEnrichissement)).catch(
              () => new Map<string, NomDebrid[]>(),
            )
          : Promise.resolve(new Map<string, NomDebrid[]>()),

        config.ad && liensAVerifier.length > 0 && budgetEnrichissement > 500
          ? cached<[string, InfoLien][]>(
              // Cle VERSIONNEE. Une entree ecrite par une version anterieure du code peut
              // avoir une tout autre forme — ici une Map serialisee, devenue « {} », que
              // le code suivant ne sait pas parcourir.
              `ddlinfos:v2:${[...new Set(liensAVerifier)].sort().join('|').slice(0, 300)}:${liensAVerifier.length}`,
              2 * 60 * 60 * 1000,
              async () => [
                ...(await infosLiens(
                  liensAVerifier,
                  config.ad as string,
                  AbortSignal.timeout(budgetEnrichissement),
                )),
              ],
              { scope: 'ddlinfos', shouldCache: (v) => v.length > 0, negativeTtlMs: 10 * 60 * 1000 },
            ).catch(() => [] as [string, InfoLien][])
          : Promise.resolve([] as [string, InfoLien][]),
      ]),
    );

    const etatLiens = new Map<string, InfoLien>(Array.isArray(paires) ? paires : []);

    /** Le debrideur qui servira REELLEMENT ce flux, et s'il l'a deja. */
    const servirPar = (c: Candidate): { service?: NomDebrid; pret?: boolean } => {
      if (c.kind === 'direct') return {};
      const detenteurs = c.infoHash ? enCache.get(c.infoHash.toLowerCase()) : undefined;
      // Le premier detenteur suit l'ordre de `servicesFor`, donc celui que la
      // resolution empruntera : l'etiquette ne peut pas mentir sur le service.
      if (detenteurs && detenteurs.length > 0) return { service: detenteurs[0], pret: true };
      // Un lien DDL derriere un redirecteur ne peut etre traverse que par AllDebrid :
      // annoncer TorBox serait faux, meme s'il est configure.
      const redirige = c.kind === 'ddl' && c.ddlUrl ? isRedirector(c.ddlUrl) : false;
      // Hors cache, c'est la PREFERENCE de l'utilisateur qui decide — l'addon n'a
      // aucune raison de trancher a sa place entre deux comptes qui lui appartiennent.
      // Un redirecteur reste l'exception : seul AllDebrid sait le traverser, annoncer
      // TorBox serait faux meme s'il est prefere.
      const prefere: NomDebrid | undefined =
        config.debrid === 'alldebrid' ? (config.ad ? 'alldebrid' : undefined)
        : config.debrid === 'torbox' ? (config.tb ? 'torbox' : undefined)
        : undefined;
      const defaut: NomDebrid | undefined =
        redirige && config.ad
          ? 'alldebrid'
          : (prefere ?? (config.tb ? 'torbox' : config.ad ? 'alldebrid' : undefined));
      // Sans hash (DDL), la disponibilite ne se verifie pas : on n'affirme rien.
      return { service: defaut, pret: c.infoHash ? false : undefined };
    };

    // Filtres puis tri, sur des flux qui portent leur etat de cache : c'est lui qui
    // decide de l'option « seulement le cache » comme de la tete de liste.
    const etats: EtatFlux[] = deduplique
      .filter((c) => {
        // Fichier disparu de chez l'hebergeur : on ne le propose pas, et on le retient
        // pour ne pas le reproposer aux autres. `hoteInconnu` n'est PAS un motif de
        // rejet — il dit seulement qu'AllDebrid ne gere pas cet hote, alors que TorBox
        // le gere peut-etre.
        const info = c.ddlUrl ? etatLiens.get(c.ddlUrl) : undefined;
        if (info?.mort) {
          marquerMort(c.ddlUrl as string);
          return false;
        }
        return true;
      })
      .map((c) => {
        const info = c.ddlUrl ? etatLiens.get(c.ddlUrl) : undefined;
        // Un lien d'hebergeur VERIFIE vivant demarre tout de suite : rien a
        // telecharger, juste un deblocage. Il merite donc le meme statut qu'un fichier
        // en cache, sans quoi « uniquement ce qui est pret » le ferait disparaitre
        // alors qu'il est precisement ce qu'on peut promettre.
        const vivant = info !== undefined && !info.mort && !info.hoteInconnu;
        return {
          // La taille vient de l'hebergeur lui-meme : les sites DDL ne l'annoncent pas.
          candidate: info?.taille ? { ...c, sizeBytes: c.sizeBytes ?? info.taille } : c,
          cached: vivant ? true : servirPar(c).pret,
        };
      });

    const filtres = {
      cachedOnly: config.cachedOnly,
      minResolution: config.minResolution,
      maxResolution: config.maxResolution,
      minSource: config.minSource,
      maxSizeGb: config.maxSizeGb,
      episodesSaison: episodesSaison,
      excludeFormats: config.excludeFormats,
      excludeCam: config.excludeCam,
      frOnly: config.frOnly,
    };

    // 0 = « pas de limite de mon cote » : le plafond de l'operateur s'applique quand meme.
    const plafond = config.maxResults > 0
      ? Math.min(config.maxResults, settings.maxStreams)
      : settings.maxStreams;

    const kept = etats
      .filter((e) => passeFiltres(e, filtres))
      .sort((a, b) =>
        comparer(a, b, {
          langOrder,
          sortBy: config.sortBy,
          priorite: config.priorite,
          bonusHdr: config.bonusHdr,
        }),
      )
      .slice(0, plafond);

    // LANGUES LUES DANS LE FICHIER, pour les premiers de la liste.
    //
    // Ce que le nom annonce ne vaut rien : il ment dans les deux sens, et seuls deux
    // trackers sur sept publient leur MediaInfo. On va donc lire l'en-tete du fichier,
    // qui est la seule verite — mais uniquement la ou c'est raisonnable :
    //
    //   - apres le tri, donc sur les entrees que l'utilisateur verra vraiment ;
    //   - seulement ce qui est DEJA PRET chez un debrideur, pour ne rien mettre en
    //     telechargement au seul motif de regarder son en-tete ;
    //   - en parallele, sous plafond, et jamais si le budget est deja consomme.
    //
    // Le resultat est memorise sur le HASH pendant trois mois : le cout n'est paye
    // qu'une fois par fichier, pour tout le monde.
    const aMesurer = kept
      .filter((e) => e.cached === true && e.candidate.infoHash && !e.candidate.languesIntegrees)
      .slice(0, MAX_MESURES);

    // LA MESURE NE BLOQUE PLUS LA REPONSE.
    //
    // Elle coute une resolution chez le debrideur plus une requete Range par fichier :
    // du temps qu'aucun lecteur n'attend. Comme le resultat est memorise sur le HASH
    // pendant trois mois, le faire APRES avoir repondu ne perd rien — la recherche
    // suivante sur le meme titre en profitera, et c'est la que ca compte.
    //
    // Cela change une chose, qu'il faut assumer : sur un titre jamais consulte, la
    // premiere reponse ne connait pas encore les langues integrees. Le filtre
    // « ecarter ce qui n'a pas de francais » ne coupe donc rien qu'il ignore, ce qui
    // est deja sa regle.
    if (aMesurer.length > 0) {
      void Promise.all(
        aMesurer.map((e) =>
          languesDuFichier(e.candidate.infoHash as string, () =>
            resolve(
              {
                kind: 'torrent',
                value: e.candidate.infoHash as string,
                fileHint: e.candidate.fileHint,
                ad: config.ad,
                tb: config.tb,
                pref: config.debrid,
              },
              AbortSignal.timeout(8000),
            ),
          ).catch(() => null),
        ),
      ).then(() => {
        console.log(`[Pistes] ${aMesurer.length} fichier(s) mesure(s) en tache de fond`);
      });
    }

    // SANS le segment de config, volontairement : le jeton /resolve porte deja les
    // cles debrid dont la resolution a besoin. L'y ajouter n'apportait rien et
    // repandait la config dans une URL de plus.
    //
    // C'est ce qui a casse toute la lecture torrent et DDL en production : les liens
    // etaient bien emis en /<config>/resolve/<jeton>, mais seule la route /resolve
    // etait enregistree — donc 404 au moindre appui sur Play.
    const base = getBaseUrl(req);

    // Identite de l'oeuvre, transmise au formateur pour qu'il puisse fabriquer un
    // `behaviorHints.filename` analysable quand la source ne fournit qu'un titre nu.
    // Elle ne change RIEN a l'affichage : ni le nom, ni la description, ni les
    // behaviorHints existants.
    const identite = {
      annee: work.year,
      saison: parsed.season,
      episode: parsed.episode,
      titreOeuvre: work.titles[0],
      episodesSaison,
    };

    /**
     * Pistes a attacher au flux, servies par NOS endpoints comme celles de la
     * ressource — un lien direct vers l'hebergeur ne s'affiche pas (CORS, format).
     * Seules les sources qui portent leurs propres pistes en fournissent : KissKH sait
     * lesquelles vont avec SON flux, ce qu'aucun addon generique ne peut deviner.
     */
    const pistesDe = (c: Candidate): PisteFlux[] | undefined => {
      if (!config.subsSurFlux || !c.subs || c.subs.length === 0) return undefined;
      const rang = (lang: string): number => {
        const i = config.subLangs.indexOf(lang);
        return i === -1 ? 100 : i;
      };
      return [...c.subs]
        .sort((a, b) => rang(a.lang) - rang(b.lang))
        .map((t, i) => ({
          // Prefixe chiffre pour la meme raison que sur la ressource /subtitles :
          // remonter dans les lecteurs qui trient les pistes sur leur identifiant.
          id: `0${i}-dramallyu-flux`,
          url: `${base}/sub/${encodeToken({ k: 'ddl', v: t.url })}.vtt`,
          // DEUX formes, volontairement. Stremio lit `lang` (code ISO 639-2) ; les
          // providers de Nuvio, eux, produisent `{ url, language: 'English' }` — un
          // NOM, pas un code. Emettre les deux evite qu'un lecteur reçoive un champ
          // vide et relegue la piste en fin de liste, ou l'ignore.
          lang: t.lang,
          language: nomLangue(t.lang),
          // La premiere est celle de la langue demandee en tete : la marquer par
          // defaut la fait selectionner d'emblee chez les lecteurs qui honorent ce
          // drapeau, ce qui vaut mieux que d'esperer un bon ordre d'affichage.
          ...(i === 0 ? { default: true } : {}),
        }));
    };

    const streams: StremioStream[] = kept.map(({ candidate: c }) => {
      if (c.kind === 'direct' && c.directUrl) {
        // Un flux qui exige un Referer casse chez plusieurs lecteurs : Stremio
        // n'applique pas toujours proxyHeaders aux segments HLS, seulement a la
        // requete initiale. On le fait donc passer par MediaFlow, qui reinjecte les
        // en-tetes sur chaque segment.
        //
        // MAIS uniquement dans ce cas : router aussi les flux SANS en-tete ferait
        // transiter toute la bande passante par le serveur, sans rien resoudre.
        // Et si MediaFlow n'est pas configure, throughMediaflow rend l'URL telle
        // quelle — l'addon reste fonctionnel, avec les proxyHeaders pour seul recours.
        const needsHeaders = c.headers && Object.keys(c.headers).length > 0;
        const playUrl = needsHeaders ? throughMediaflow(c.directUrl, c.headers) : c.directUrl;
        return toStremioStream(c, { playUrl, sousTitres: pistesDe(c), ...identite });
      }
      // Torrent ou DDL : on differe la resolution au moment du Play.
      const token = encodeToken({
        k: c.kind === 'torrent' ? 'torrent' : 'ddl',
        v: c.kind === 'torrent' ? (c.infoHash || c.magnet || '') : (c.ddlUrl || ''),
        f: c.fileHint,
        // N'est transmis que si l'utilisateur l'accepte : ce lien engage son compte
        // de tracker (cf. `envoyerTorrent`).
        t: config.envoyerTorrent ? c.torrentUrl : undefined,
        ad: config.ad,
        tb: config.tb,
        pref: config.debrid,
      });
      const { service, pret } = servirPar(c);
      return toStremioStream(c, {
        playUrl: `${base}/resolve/${token}`,
        viaDebrid: true,
        debrid: service,
        cached: pret,
        sousTitres: pistesDe(c),
        ...identite,
      });
    });

    const elapsed = Date.now() - started;
    const detail = Object.entries(timings)
      .map(([k, v]) => `${k}=${v}ms`)
      .join(' ');
    console.log(
      `[Stream] ${req.params.type}/${req.params.id} -> ${streams.length} flux en ${elapsed}ms` +
        (detail ? ` (${detail})` : '') +
        (timedOut.length ? ` [abandon: ${timedOut.join(',')}]` : '') +
        ` | phases: ${Object.entries(phases).map(([k, v]) => `${k}=${v}ms`).join(' ')}`,
    );

    // Quand on ne trouve RIEN, la question suivante est toujours la meme : a-t-on
    // cherche sous le bon nom ? Un film coreen listé sous son titre d'origine est
    // introuvable si on n'a interroge que sa traduction anglaise. On trace donc les
    // formes de titre reellement employees — c'est la difference entre « aucune
    // source ne l'a » et « on a mal demande », et sans ca les deux se ressemblent.
    if (streams.length === 0) {
      console.log(`[Stream] ...titres cherches : ${query.titles.join(' | ') || '(aucun)'}`);
    }

    // PREPARATION DES SOUS-TITRES, des maintenant.
    //
    // L'utilisateur ouvre la fiche (cette requete), puis lance la lecture, puis
    // seulement demande une piste : plusieurs secondes s'ecoulent. On connait deja
    // l'URL de la piste dans SA langue — autant l'avoir prete quand il la reclamera,
    // plutot que de lui faire attendre le telechargement, le dechiffrement et la
    // conversion pendant que la video, elle, tourne deja.
    //
    // Une seule piste, celle de sa langue prioritaire, et seulement sur nos sources
    // directes : ce sont les seules dont on connait les pistes a cet instant.
    const aPreparer = kept
      .flatMap((e) => e.candidate.subs ?? [])
      .filter((t) => t.lang === config.subLangs[0])
      .slice(0, 1)
      .map((t) => t.url);
    if (aPreparer.length > 0) prechauffer(aPreparer);

    noterRequete({
      quand: Date.now(),
      type,
      id: req.params.id,
      titre: work.titles[0],
      flux: streams.length,
      ms: elapsed,
      parSource: timings,
      apports,
      abandonnees: timedOut,
      note: streams.length === 0 ? `titres cherches : ${query.titles.join(' | ')}` : undefined,
    });

    res.json({ streams });
  } catch (e) {
    console.error(`[Stream] echec ${req.params.id}: ${(e as Error).message}`);
    // Une exception ne doit jamais remonter en 500 a Stremio : il afficherait une
    // erreur alors qu'une liste vide est le bon comportement.
    res.json({ streams: [] });
  }
}
