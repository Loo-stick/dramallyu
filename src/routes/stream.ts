// Handler /stream — le coeur de l'addon.
//
// Sequence : identite -> fan-out sous budget -> dedup -> tri -> mise en forme.
// Aucun debridage ici (cf. debrid/token.ts pour le pourquoi).

import type { Request, Response } from 'express';
import { parseConfig } from '../core/config';
import { parseStremioId } from '../core/ids';
import { resolveWork, estAsiatique } from '../core/meta';
import { searchAll } from '../core/registry';
import { getSettings } from '../core/settings';
import { langOrderFromSubs } from '../core/prefs';
import { comparer, passeFiltres, type EtatFlux } from '../core/filters';
import { toStremioStream, type StremioStream } from '../core/display';
import { getBaseUrl } from '../core/url';
import { encodeToken } from '../debrid/token';
import { cacheParService, type NomDebrid } from '../debrid/resolver';
import { isRedirector } from '../debrid/alldebrid';
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
    const { candidates, timings, timedOut } = await searchAll(query, config);

    const settings = getSettings();
    const langOrder = langOrderFromSubs(config.subLangs);
    const deduplique = dedupe(candidates);

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
    const enCache =
      hashes.length > 0 ? await cacheParService(hashes, config) : new Map<string, NomDebrid[]>();

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
      const defaut: NomDebrid | undefined =
        redirige && config.ad ? 'alldebrid' : config.tb ? 'torbox' : config.ad ? 'alldebrid' : undefined;
      // Sans hash (DDL), la disponibilite ne se verifie pas : on n'affirme rien.
      return { service: defaut, pret: c.infoHash ? false : undefined };
    };

    // Filtres puis tri, sur des flux qui portent leur etat de cache : c'est lui qui
    // decide de l'option « seulement le cache » comme de la tete de liste.
    const etats: EtatFlux[] = deduplique.map((c) => ({ candidate: c, cached: servirPar(c).pret }));

    const filtres = {
      cachedOnly: config.cachedOnly,
      minResolution: config.minResolution,
      maxResolution: config.maxResolution,
      minSource: config.minSource,
      maxSizeGb: config.maxSizeGb,
      excludeFormats: config.excludeFormats,
      excludeCam: config.excludeCam,
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

    // SANS le segment de config, volontairement : le jeton /resolve porte deja les
    // cles debrid dont la resolution a besoin. L'y ajouter n'apportait rien et
    // repandait la config dans une URL de plus.
    //
    // C'est ce qui a casse toute la lecture torrent et DDL en production : les liens
    // etaient bien emis en /<config>/resolve/<jeton>, mais seule la route /resolve
    // etait enregistree — donc 404 au moindre appui sur Play.
    const base = getBaseUrl(req);
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
        return toStremioStream(c, { playUrl });
      }
      // Torrent ou DDL : on differe la resolution au moment du Play.
      const token = encodeToken({
        k: c.kind === 'torrent' ? 'torrent' : 'ddl',
        v: c.kind === 'torrent' ? (c.infoHash || c.magnet || '') : (c.ddlUrl || ''),
        f: c.fileHint,
        ad: config.ad,
        tb: config.tb,
      });
      const { service, pret } = servirPar(c);
      return toStremioStream(c, {
        playUrl: `${base}/resolve/${token}`,
        viaDebrid: true,
        debrid: service,
        cached: pret,
      });
    });

    const elapsed = Date.now() - started;
    const detail = Object.entries(timings)
      .map(([k, v]) => `${k}=${v}ms`)
      .join(' ');
    console.log(
      `[Stream] ${req.params.type}/${req.params.id} -> ${streams.length} flux en ${elapsed}ms` +
        (detail ? ` (${detail})` : '') +
        (timedOut.length ? ` [abandon: ${timedOut.join(',')}]` : ''),
    );

    res.json({ streams });
  } catch (e) {
    console.error(`[Stream] echec ${req.params.id}: ${(e as Error).message}`);
    // Une exception ne doit jamais remonter en 500 a Stremio : il afficherait une
    // erreur alors qu'une liste vide est le bon comportement.
    res.json({ streams: [] });
  }
}
