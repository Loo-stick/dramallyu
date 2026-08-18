// Ressource /subtitles + endpoint de service des pistes.
//
// POURQUOI UNE RESSOURCE ET PAS DES SUBS SUR LE STREAM : Nuvio IGNORE purement et
// simplement le champ `subtitles` d'un objet Stream (verifie sur HLS comme sur MP4).
// La ressource est le seul mecanisme qui marche sur les deux clients. Corollaire :
// on ne met JAMAIS aussi les sous-titres au niveau du stream, sinon Nuvio empile les
// pistes en double.
//
// Deux autres regles imposees par les clients :
//   - codes langue en ISO 639-2 (fre/eng), pas en ISO 639-1 (fr/en) ;
//   - les URLs pointent vers NOS endpoints, qui servent du text/vtt — un lien direct
//     vers l'hebergeur d'origine ne s'affiche pas (CORS, format, en-tetes).

import type { Request, Response } from 'express';
import { parseConfig, identite } from '../core/config';
import { parseStremioId } from '../core/ids';
import { resolveWork, estAsiatique } from '../core/meta';
import { subtitlesAll } from '../core/registry';
import { findSubtitles } from '../subs/opensubtitles';
import { toVtt } from '../subs/convert';
import { estChiffre, dechiffrerVtt } from '../sources/direct/kisskh/subdecrypt';
import { getBaseUrl } from '../core/url';
import { encodeToken, decodeToken } from '../debrid/token';
import { httpGet } from '../core/http';
import { get, set } from '../core/cache';
import { createHash } from 'node:crypto';
import type { MediaType, SubTrack } from '../sources/types';

/**
 * Adresse STABLE d'une piste, derivee de son contenu.
 *
 * Elle etait chiffree, donc differente a chaque appel : le vecteur d'initialisation
 * est aleatoire, par construction. Consequence, invisible jusqu'a ce qu'on la cherche
 * — aucun cache intermediaire ne pouvait servir deux fois la meme piste, puisqu'il ne
 * voyait jamais deux fois la meme URL. Cloudflare comptait chaque requete comme
 * nouvelle et la faisait remonter jusqu'ici.
 *
 * On adresse donc par le CONTENU : l'identifiant est une empreinte de l'URL source,
 * et la correspondance est gardee de notre cote. C'est aussi plus sur que le jeton
 * chiffre — l'endpoint ne peut servir QUE des adresses qu'on a nous-memes enregistrees,
 * la ou un jeton dechiffrable acceptait tout ce qui se dechiffrait correctement.
 */
const TTL_ADRESSE_MS = 30 * 24 * 60 * 60 * 1000;

export function adresseDePiste(base: string, url: string): string {
  const id = createHash('sha256').update(url).digest('base64url').slice(0, 32);
  set(`subid:${id}`, url, TTL_ADRESSE_MS, 'subid');
  return `${base}/sub/${id}.vtt`;
}

function subUrl(base: string, track: SubTrack): string {
  return adresseDePiste(base, track.url);
}

export async function handleSubtitles(req: Request, res: Response): Promise<void> {
  const debut = Date.now();
  const config = parseConfig((req.params as Record<string, string>).config);
  const type: MediaType = req.params.type === 'movie' ? 'movie' : 'series';
  const parsed = parseStremioId(req.params.id);
  if (!parsed) {
    res.json({ subtitles: [] });
    return;
  }

  try {
    const work = await resolveWork(parsed, type, config);
    if (!work) {
      res.json({ subtitles: [] });
      return;
    }

    // Hors creneau : on s'arrete AVANT d'interroger la moindre source. Repondre une
    // liste vide apres avoir scrape et depose des magnets ne servirait personne.
    if (!estAsiatique(work)) {
      console.log(`[Perimetre] ${req.params.id} hors creneau (${work.country ?? work.originalLanguage ?? '?'})`);
      res.json({ subtitles: [] });
      return;
    }

    const query = {
      type,
      imdbId: work.imdbId,
      tmdbId: work.tmdbId,
      kkhId: work.kkhId,
      titles: work.titles,
      year: work.year,
      season: parsed.season,
      episode: parsed.episode,
      originalLanguage: work.originalLanguage,
    };

    // Les sources d'abord (KissKH porte de vraies pistes synchronisees avec SON flux),
    // OpenSubtitles ensuite en complement pour les langues manquantes.
    let t = Date.now();
    const fromSources = await subtitlesAll(query, config);
    const msSources = Date.now() - t;

    const missing = config.subLangs.filter((l) => !fromSources.some((t2) => t2.lang === l));
    t = Date.now();
    const external = (
      await Promise.all(
        missing.map((lang) =>
          findSubtitles(work.imdbId, lang, parsed.season, parsed.episode).catch(() => []),
        ),
      )
    ).flat();
    const msExterne = Date.now() - t;

    const base = getBaseUrl(req);
    const seen = new Set<string>();
    const rang = (lang: string): number => {
      const i = config.subLangs.indexOf(lang);
      return i === -1 ? 100 : i;
    };

    const uniques = [...fromSources, ...external].filter((t) => {
      if (seen.has(t.url)) return false;
      seen.add(t.url);
      return true;
    });

    // ON NE SERT QUE LES LANGUES DEMANDEES.
    //
    // KissKH livre parfois sept pistes — khmer, indonesien, malais, thai, arabe —
    // pour quelqu'un qui n'a demande que le francais. Les renvoyer toutes a deux
    // couts : elles encombrent le menu du lecteur, et surtout certains lecteurs les
    // PRECHARGENT. Sur le trajet reel (Cloudflare puis liaison domestique), chaque
    // piste coute ~200 ms : sept pistes au lieu d'une, c'est une seconde et demie
    // d'attente pour rien. C'est exactement l'ecart de ressenti avec LooStream, qui
    // n'interroge OpenSubtitles qu'en francais.
    //
    // REPLI INDISPENSABLE : si aucune piste ne correspond, on rend ce qu'on a. Un
    // sous-titre dans une langue approchante vaut mieux qu'un menu vide, et
    // l'utilisateur reste libre de l'ignorer.
    const demandees = uniques.filter((t) => config.subLangs.includes(t.lang));
    const retenues = demandees.length > 0 ? demandees : uniques;

    const subtitles = retenues
      // TRI FINAL, et il est indispensable : concatener « sources puis OpenSubtitles »
      // renvoie le francais en DERNIER des que la source n'en a pas — alors que c'est
      // justement la langue que l'utilisateur a demandee en premier. Les lecteurs
      // presentent les pistes dans l'ordre reçu.
      .sort((a, b) => rang(a.lang) - rang(b.lang))
      .map((t, i) => ({
        // IDENTIFIANT NEUTRE. Il a porte un prefixe chiffre — « 00-dramallyu » — pour
        // tenter de remonter dans les lecteurs qui trient les pistes sur ce champ. Je
        // l'avais annonce sans risque : il ne l'etait pas.
        //
        // Constate en production sur Nuvio : la piste s'AFFICHAIT en tete mais se
        // SELECTIONNAIT a sa position d'origine. Cliquer sur notre ligne ne donnait
        // rien, et cliquer sur celle du dessous activait la notre. Un lecteur qui trie
        // l'affichage sans reordonner ce qu'il selectionne produit exactement ce
        // decalage — et rien dans le protocole ne lui interdit.
        //
        // La lecon vaut au-dela d'ici : un champ qu'on detourne de son role pour
        // influencer un comportement non specifie finit par en casser un autre.
        id: `dramallyu-${i}`,
        url: subUrl(base, t),
        lang: t.lang,
        // AUCUN CHAMP DE PLUS. Le protocole Stremio definit `id`, `url` et `lang` :
        // rien d'autre.
        //
        // J'avais ajoute un `language` en clair (« Français »), deduit du code des
        // PROVIDERS de Nuvio — qui ne sont pas son client. C'etait une supposition,
        // presentee comme sans risque. Or l'autre supposition du meme genre, le
        // prefixe chiffre sur l'identifiant, a fini par casser la SELECTION des
        // pistes en production.
        //
        // On s'en tient donc a la forme documentee. Un lecteur qui rencontre un champ
        // qu'il n'attend pas n'a aucune obligation de l'ignorer proprement.
        // AUCUN DRAPEAU « default » ICI, et c'est un retour en arriere assume.
        //
        // Cette ressource repond pour N'IMPORTE QUEL flux, y compris ceux d'un autre
        // addon et les releases torrent qui embarquent leurs propres pistes. Sur une
        // release « Multi-Subs », les sous-titres INTEGRES sont cales au frame pres,
        // alors que les notres viennent d'un autre encodage — montage different,
        // recaps, coupures : tout glisse.
        //
        // Marquer notre piste par defaut detournait donc la selection automatique du
        // lecteur au profit de la moins bonne. Le drapeau avait ete pose pour corriger
        // l'ordre d'affichage dans Nuvio ; il ne l'a jamais corrige (c'est la position
        // de l'addon dans la liste qui commande), et il coutait ça.
      }));

    // Preparation en tache de fond, AVANT de repondre : le lecteur passera quelques
    // dizaines de millisecondes a lire notre JSON, autant s'en servir.
    prechauffer(retenues.map((t) => t.url));

    // TRACE, comme /stream en a une. Sans elle, ce chemin etait un angle mort : on ne
    // voyait que ses echecs, jamais sa duree — impossible de savoir si une lenteur
    // ressentie venait d'ici ou du lecteur.
    console.log(
      `[Subtitles] ${identite(config) ? `[${identite(config)}] ` : ''}${req.params.type}/${req.params.id} -> ${subtitles.length} piste(s) ` +
        `en ${Date.now() - debut}ms (sources=${msSources}ms externe=${msExterne}ms)`,
    );

    res.json({ subtitles });
  } catch (e) {
    console.error(`[Subtitles] echec ${req.params.id}: ${(e as Error).message}`);
    res.json({ subtitles: [] });
  }
}

const MAX_SUB_BYTES = 4 * 1024 * 1024;

/**
 * Recupere une piste, la convertit en VTT, la dechiffre au besoin, et la memorise.
 *
 * Extrait du gestionnaire HTTP pour pouvoir etre appele AILLEURS : c'est ce qui permet
 * de preparer une piste avant que le lecteur ne la demande.
 */
/**
 * Preparations DEJA EN COURS, par adresse.
 *
 * Le prechauffage lance le telechargement d'une piste puis rend la liste au lecteur.
 * Celui-ci reclame le fichier une cinquantaine de millisecondes plus tard, alors que le
 * telechargement en cours durera pres d'une seconde : le cache est donc encore vide, et
 * `/sub` repartait telecharger LA MEME piste une seconde fois. Deux appels sortants
 * pour un fichier, chez un fournisseur qui limite le debit par adresse IP.
 *
 * On rejoint desormais le travail en cours au lieu de le doubler. Le gain n'est pas sur
 * l'attente du lecteur — elle vaut la duree du telechargement dans les deux cas — mais
 * sur ce qu'on demande a OpenSubtitles.
 */
const enPreparation = new Map<string, Promise<string | null>>();

async function preparerVtt(url: string): Promise<string | null> {
  const cleVtt = `vtt:${url}`;
  const memorise = get<string>(cleVtt);
  if (memorise) return memorise;

  const enCours = enPreparation.get(url);
  if (enCours) return enCours;

  const travail = telechargerVtt(url, cleVtt);
  enPreparation.set(url, travail);
  try {
    return await travail;
  } finally {
    // Retire dans TOUS les cas : une entree laissee derriere ferait resservir
    // indefiniment un echec, et la table grossirait sans borne.
    enPreparation.delete(url);
  }
}

/** Telechargement, conversion et dechiffrement effectifs. */
async function telechargerVtt(url: string, cleVtt: string): Promise<string | null> {

  // En binaire : OpenSubtitles sert des .srt.gz, qu'un decodage texte detruirait
  // avant meme qu'on puisse les decompresser.
  const response = await httpGet<ArrayBuffer>(url, {
    timeoutMs: 15000,
    responseType: 'buffer',
    maxBytes: MAX_SUB_BYTES,
    retries: 1,
  });
  if (!response || response.status < 200 || response.status >= 300) return null;

  const buf = Buffer.isBuffer(response.data)
    ? (response.data as Buffer)
    : Buffer.from(response.data as ArrayBuffer);
  const vtt = toVtt(buf);
  if (!vtt) return null;

  // Pistes KissKH chiffrees : le FICHIER est structurellement valide, seules les
  // repliques sont brouillees. On tente le dechiffrement, et on refuse de servir si
  // le resultat n'est pas credible — du charabia par-dessus la video serait pire que
  // pas de sous-titres du tout.
  let corps = vtt;
  if (estChiffre(url)) {
    const clair = await dechiffrerVtt(vtt, url);
    if (!clair) return null;
    corps = clair;
  }

  // Une piste ne change jamais : douze heures de memorisation, et la selection
  // suivante est instantanee. On borne la taille memorisee — un fichier aberrant n'a
  // pas a occuper le cache partage par tout le reste.
  if (corps.length < 512 * 1024) set(cleVtt, corps, 12 * 60 * 60 * 1000, 'vtt');
  return corps;
}

/**
 * Prepare les pistes retenues SANS faire attendre personne.
 *
 * Le lecteur demande d'abord la liste, puis le fichier : deux allers-retours en
 * serie. Mesure en local, a froid : 635 ms pour la liste, 647 ms pour le fichier —
 * plus le reseau, environ 1,7 s avant que le texte n'apparaisse a l'ecran, alors que
 * la video, elle, a demarre tout de suite.
 *
 * Or on connait deja l'URL au moment de repondre la liste. On lance donc la
 * preparation pendant que le lecteur lit notre reponse : quand il reclame le fichier,
 * il est pret. Le cout est nul pour lui, et le travail aurait ete fait de toute façon.
 */
/**
 * Prepare la piste EXTERNE de la langue prioritaire, des l'ouverture de la fiche.
 *
 * `prechauffer` ne suffisait pas pour OpenSubtitles : `/stream` ne connait que les
 * pistes des sources directes, et le prechauffage lance depuis `/subtitles` ne peut pas
 * gagner la course — le lecteur reclame le fichier une cinquantaine de millisecondes
 * apres avoir reçu la liste, pour un telechargement qui dure pres d'une seconde. Le
 * texte apparaissait donc avec ce retard, alors que la video, elle, tournait deja.
 *
 * Ici on part quand l'utilisateur OUVRE la fiche : il lui reste a choisir un flux et a
 * lancer la lecture, soit plusieurs secondes d'avance. La recherche et le fichier sont
 * mis en cache, donc l'appel de `/subtitles` qui suit ne redemande rien.
 *
 * Une seule langue et une seule piste : c'est un appel sortant chez un fournisseur qui
 * limite par adresse IP, et il a lieu meme pour une fiche seulement parcourue.
 */
export function prechaufferExterne(
  imdbId: string | undefined,
  langs: string[],
  season?: number,
  episode?: number,
): void {
  if (!imdbId || langs.length === 0) return;
  void (async () => {
    // On parcourt les langues DANS L'ORDRE de preference, et l'on s'arrete a la
    // premiere qui donne quelque chose. Ne prechauffer que la premiere ne servait a
    // rien des qu'elle manquait : sur « 1 Litre of Tears » il n'existe pas de piste
    // francaise, le lecteur recevait donc l'anglaise — celle qu'on n'avait pas
    // preparee. Les recherches sont les memes que celles que `/subtitles` fera juste
    // apres, et elles sont mises en cache : rien de plus ne sort d'ici.
    for (const lang of langs) {
      const pistes = await findSubtitles(imdbId, lang, season, episode).catch(() => []);
      const url = pistes[0]?.url;
      if (url) {
        prechauffer([url]);
        return;
      }
    }
  })();
}

export function prechauffer(urls: string[]): void {
  for (const url of urls.slice(0, 2)) {
    void preparerVtt(url).catch(() => null);
  }
}

/**
 * Au-dela de ce delai, servir une piste est journalise.
 *
 * En deça, le prechauffage a fait son travail et il n'y a rien a dire ; le journal
 * ecarte volontairement `/sub/` (cf. `index.ts`) pour ne pas noyer le reste sous une
 * ligne par piste. Mais l'angle mort etait total : « les sous-titres mettent parfois
 * quelques secondes » n'etait ni verifiable, ni refutable, et un 502 « injoignable »
 * partait sans une trace. On ne peut pas conclure qu'on n'y peut rien sur ce qu'on ne
 * voit pas.
 */
const SEUIL_PISTE_LENTE_MS = 400;

/** Sert une piste convertie en VTT. Le jeton signe evite le proxy ouvert. */
export async function handleServeSub(req: Request, res: Response): Promise<void> {
  const debut = Date.now();
  const raw = String(req.params.token || '').replace(/\.vtt$/i, '');

  // Adresse stable (forme actuelle), ou ancien jeton chiffre — des liens en circulation
  // en portent encore, et une piste qui cesserait de s'afficher apres une mise a jour
  // serait un mauvais echange.
  const url = get<string>(`subid:${raw}`) ?? decodeToken(raw)?.v;
  if (!url) {
    console.log(`[Sub] jeton inconnu ou expire (${raw.slice(0, 12)}…)`);
    res.status(404).type('text/plain').send('piste inconnue ou expiree');
    return;
  }

  // Releve AVANT la preparation : c'est ce qui distingue « le prechauffage a servi » de
  // « on est alle la chercher pendant que le lecteur attendait ».
  // `get` rend `null` sur absence, jamais `undefined` : compare a `null`, sinon
  // l'indicateur est vrai en permanence et annonce un prechauffage qui n'a pas eu lieu.
  const dejaPrete = get<string>(`vtt:${url}`) !== null;
  const ou = hote(url);

  const corps = await preparerVtt(url);
  const ms = Date.now() - debut;
  if (!corps) {
    // TOUJOURS journalise : une piste annoncee dans la liste puis refusee au service
    // est invisible cote lecteur, qui affiche simplement... rien.
    console.log(`[Sub] ECHEC ${ou} en ${ms}ms — injoignable ou illisible`);
    res.status(502).type('text/plain').send('sous-titre injoignable ou illisible');
    return;
  }

  if (ms >= SEUIL_PISTE_LENTE_MS) {
    console.log(
      `[Sub] ${ou} en ${ms}ms, ${Math.round(corps.length / 1024)} Ko` +
        (dejaPrete ? ' (deja prete — la lenteur est ailleurs)' : ' (NON prechauffee : allee la chercher pendant que le lecteur attendait)'),
    );
  }

  servirVtt(res, corps);
}

/** Hote d'une adresse, pour dire d'ou vient une piste sans recopier ses parametres. */
function hote(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'adresse illisible';
  }
}

/** En-tetes communs aux deux chemins, pour qu'ils ne divergent jamais. */
function servirVtt(res: Response, corps: string): void {
  res.set('Content-Type', 'text/vtt; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(corps);
}
