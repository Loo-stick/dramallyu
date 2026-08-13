// Resolution d'identite : d'un id Stremio vers ce dont les sources ont besoin
// (des titres, une annee, une langue d'origine).
//
// REGLE STRUCTURANTE : rien de ce qui est PARTAGE entre utilisateurs ne peut dependre
// d'une cle. Comme aucune cle n'est fournie par l'operateur, la resolution par defaut
// passe par Cinemeta — public, sans cle, sans quota, et natif Stremio.
//
// TMDB reste un BONUS individuel : titres et synopsis en francais, et surtout les
// titres alternatifs, qui sont l'arme decisive contre les romanisations asiatiques
// (« Ojingeo geim » / « Squid Game » / « Round Six » designent la meme serie).

import { getJson } from './http';
import { cached } from './cache';
import type { ParsedId } from './ids';
import type { UserConfig } from './config';
import type { MediaType } from '../sources/types';

const CINEMETA = 'https://v3-cinemeta.strem.io';
const TMDB = 'https://api.themoviedb.org/3';
const META_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface WorkInfo {
  type: MediaType;
  /** Pays de production annonce par Cinemeta (« South Korea », « Japan »...). */
  country?: string;
  /** Titres connus, du plus fiable au moins fiable. Jamais vide si non nul. */
  titles: string[];
  year?: number;
  /** ISO 639-1 de la langue d'origine ("ko", "zh", "ja", "th"). */
  originalLanguage?: string;
  imdbId?: string;
  tmdbId?: string;
  kkhId?: string;
  poster?: string;
  description?: string;
}

interface CinemetaMeta {
  name?: string;
  year?: string;
  releaseInfo?: string;
  country?: string;
  poster?: string;
  description?: string;
  imdb_id?: string;
  moviedb_id?: number;
}

function yearOf(raw?: string): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : undefined;
}

/** Metadonnees Cinemeta. Sans cle, sans quota — le socle de la resolution. */
async function fromCinemeta(
  imdbId: string,
  type: MediaType,
  signal?: AbortSignal,
): Promise<WorkInfo | null> {
  const stremioType = type === 'series' ? 'series' : 'movie';
  return cached<WorkInfo | null>(
    // Le numero de version fait partie de la CLE, volontairement : ces objets vivent
    // 7 jours en cache, et le jour ou l'on ajoute un champ — ici `country`, dont
    // depend le garde-fou de perimetre — les entrees ecrites avant ne le portent pas.
    // Sans ce numero, le nouveau code lit pendant une semaine des donnees a l'ancien
    // format, et se comporte comme s'il n'avait pas ete modifie. Constate en
    // production : Spider-Man repassait le filtre faute de pays memorise.
    `cinemeta:v2:${stremioType}:${imdbId}`,
    META_TTL_MS,
    async () => {
      const data = await getJson<{ meta?: CinemetaMeta }>(
        `${CINEMETA}/meta/${stremioType}/${imdbId}.json`,
        { signal, timeoutMs: 10000 },
      );
      const meta = data?.meta;
      if (!meta?.name) return null;
      return {
        type,
        titles: [meta.name],
        year: yearOf(meta.year || meta.releaseInfo),
        country: meta.country,
        imdbId,
        tmdbId: meta.moviedb_id ? String(meta.moviedb_id) : undefined,
        poster: meta.poster,
        description: meta.description,
      };
    },
    { scope: 'cinemeta', shouldCache: (v) => v !== null, negativeTtlMs: 60 * 60 * 1000 },
  );
}

interface TmdbDetails {
  id: number;
  name?: string;
  title?: string;
  original_name?: string;
  original_title?: string;
  original_language?: string;
  overview?: string;
  first_air_date?: string;
  release_date?: string;
  poster_path?: string;
}

/**
 * Enrichissement TMDB. N'est appele que si l'utilisateur a fourni SA cle.
 *
 * Apporte trois choses que Cinemeta ne donne pas : le titre original, la langue
 * d'origine (qui decide si on tente le repli scraping de VoirDrama), et les titres
 * alternatifs qui rattrapent les romanisations.
 */
async function enrichWithTmdb(
  info: WorkInfo,
  apiKey: string,
  signal?: AbortSignal,
): Promise<WorkInfo> {
  const path = info.type === 'series' ? 'tv' : 'movie';

  let tmdbId = info.tmdbId;
  if (!tmdbId && info.imdbId) {
    const found = await cached<string | null>(
      `tmdbmap:${info.imdbId}`,
      MAP_TTL_MS,
      async () => {
        const data = await getJson<Record<string, { id: number }[]>>(
          `${TMDB}/find/${info.imdbId}?external_source=imdb_id&api_key=${apiKey}`,
          { signal, timeoutMs: 10000 },
        );
        const list = data?.[`${path}_results`];
        return list && list.length > 0 ? String(list[0].id) : null;
      },
      { scope: 'tmdb', shouldCache: (v) => v !== null, negativeTtlMs: 24 * 60 * 60 * 1000 },
    );
    tmdbId = found ?? undefined;
  }
  if (!tmdbId) return info;

  const details = await cached<TmdbDetails | null>(
    `tmdb:${path}:${tmdbId}:fr`,
    META_TTL_MS,
    () =>
      getJson<TmdbDetails>(`${TMDB}/${path}/${tmdbId}?api_key=${apiKey}&language=fr-FR`, {
        signal,
        timeoutMs: 10000,
      }),
    { scope: 'tmdb', shouldCache: (v) => v !== null, negativeTtlMs: 60 * 60 * 1000 },
  );
  if (!details) return { ...info, tmdbId };

  const alt = await cached<string[]>(
    `tmdb:${path}:${tmdbId}:alt`,
    META_TTL_MS,
    async () => {
      const data = await getJson<{ results?: { title?: string; iso_3166_1?: string }[] }>(
        `${TMDB}/${path}/${tmdbId}/alternative_titles?api_key=${apiKey}`,
        { signal, timeoutMs: 10000 },
      );
      const results = data?.results ?? [];
      // On garde les titres FR, US/GB et ceux du pays d'origine : au-dela, on
      // accumulerait des dizaines de formes qui degradent le matching au lieu de
      // l'aider (un titre trop generique matche n'importe quoi).
      return results
        .filter((r) => r.title && ['FR', 'US', 'GB', 'KR', 'CN', 'JP', 'TH', 'TW'].includes(r.iso_3166_1 || ''))
        .map((r) => r.title as string);
    },
    { scope: 'tmdb', shouldCache: (v) => v.length > 0, negativeTtlMs: 24 * 60 * 60 * 1000 },
  );

  const titles = [
    details.name || details.title,
    details.original_name || details.original_title,
    ...info.titles,
    ...alt,
  ].filter((t): t is string => Boolean(t));

  return {
    ...info,
    tmdbId,
    titles: [...new Set(titles)],
    originalLanguage: details.original_language || info.originalLanguage,
    year: info.year ?? yearOf(details.first_air_date || details.release_date),
    description: info.description || details.overview,
    poster: info.poster || (details.poster_path ? `https://image.tmdb.org/t/p/w500${details.poster_path}` : undefined),
  };
}

/** Images TMDB d'une fiche — sert a confirmer une correspondance KissKH par preuve. */
export async function tmdbImagePaths(
  tmdbId: string,
  type: MediaType,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const path = type === 'series' ? 'tv' : 'movie';
  return cached<string[]>(
    `tmdb:${path}:${tmdbId}:images`,
    META_TTL_MS,
    async () => {
      const data = await getJson<{
        posters?: { file_path: string }[];
        backdrops?: { file_path: string }[];
      }>(`${TMDB}/${path}/${tmdbId}/images?api_key=${apiKey}`, { signal, timeoutMs: 10000 });
      return [...(data?.posters ?? []), ...(data?.backdrops ?? [])].map((i) => i.file_path);
    },
    { scope: 'tmdb', shouldCache: (v) => v.length > 0, negativeTtlMs: 6 * 60 * 60 * 1000 },
  );
}

/**
 * Resolution PAR TMDB, quand l'utilisateur a une cle.
 *
 * Rend un socle complet a partir d'un id TMDB seul — sans dependre de Cinemeta.
 * Deux raisons de s'en servir en PREMIER plutot qu'en simple enrichissement :
 *
 *  - certains utilisateurs desinstallent Cinemeta et naviguent avec un catalogue
 *    TMDB : leurs identifiants arrivent alors en `tmdb:`, que Cinemeta ne sait pas
 *    lire (verifie : il repond 307) ;
 *  - pour un drama asiatique, TMDB est de toute façon la meilleure source — il donne
 *    la langue d'origine et les titres alternatifs, qui sont exactement ce qui
 *    rattrape les romanisations.
 */
async function fromTmdbSeul(
  tmdbId: string,
  type: MediaType,
  apiKey: string,
  signal?: AbortSignal,
): Promise<WorkInfo | null> {
  const base: WorkInfo = { type, titles: [], tmdbId };
  const enrichi = await enrichWithTmdb(base, apiKey, signal);
  return enrichi.titles.length > 0 ? enrichi : null;
}

/** Resolution depuis notre propre catalogue : la fiche KissKH porte tout le necessaire. */
async function fromKisskh(kkhId: string, signal?: AbortSignal): Promise<WorkInfo | null> {
  // Import tardif : evite un cycle client KissKH <-> meta.
  const { drama } = await import('../sources/direct/kisskh/client');
  const d = await drama(kkhId, signal);
  if (!d) return null;
  return {
    type: d.type === 'Movie' ? 'movie' : 'series',
    titles: [d.title],
    year: yearOf(d.releaseDate),
    originalLanguage: countryToLanguage(d.country),
    kkhId,
    country: d.country,
    poster: d.thumbnail,
    description: d.description,
  };
}

const COUNTRY_TO_LANG: Record<string, string> = {
  'South Korea': 'ko',
  China: 'zh',
  Japan: 'ja',
  Thailand: 'th',
  Taiwan: 'zh',
  'Hong Kong': 'zh',
  Philippines: 'tl',
  Indonesia: 'id',
  'United States': 'en',
};

export function countryToLanguage(country?: string): string | undefined {
  return country ? COUNTRY_TO_LANG[country] : undefined;
}

/**
 * Point d'entree unique : d'un id Stremio vers les informations exploitables.
 * Renvoie null quand l'oeuvre est introuvable — l'appelant rend alors une liste vide.
 */
export async function resolveWork(
  parsed: ParsedId,
  type: MediaType,
  config: UserConfig,
  signal?: AbortSignal,
): Promise<WorkInfo | null> {
  let info: WorkInfo | null = null;

  if (parsed.kind === 'kkh') {
    info = await fromKisskh(parsed.value, signal);
  } else if (parsed.kind === 'tmdb') {
    // Sans cle, un id TMDB est irresolvable : ni Cinemeta, ni Trakt, ni TMDB lui-meme
    // ne repondent sans authentification (verifie : 307, 403, 401).
    info = config.tmdb ? await fromTmdbSeul(parsed.value, type, config.tmdb, signal) : null;
    if (!info) {
      console.log(`[Meta] tmdb:${parsed.value} irresolvable — une cle TMDB est requise`);
      return null;
    }
  } else {
    // Identifiant IMDb. Avec une cle, TMDB passe EN PREMIER : il connait la langue
    // d'origine et les titres alternatifs, et il rend l'addon independant de
    // Cinemeta. Cinemeta reste le socle sans cle, et le repli si TMDB ne trouve rien.
    if (config.tmdb) {
      const base: WorkInfo = { type, titles: [], imdbId: parsed.value };
      try {
        const parTmdb = await enrichWithTmdb(base, config.tmdb, signal);
        if (parTmdb.titles.length > 0) info = parTmdb;
      } catch {
        // Cle invalide ou quota atteint : on retombe sur Cinemeta, jamais en erreur.
      }
    }
    if (!info) info = await fromCinemeta(parsed.value, type, signal);

    // Cinemeta apporte le PAYS, que TMDB ne donne pas sous cette forme et dont le
    // garde-fou de perimetre se sert quand la langue d'origine manque.
    if (info && !info.country && !info.originalLanguage) {
      const parCinemeta = await fromCinemeta(parsed.value, type, signal);
      if (parCinemeta?.country) info.country = parCinemeta.country;
    }
  }

  if (!info) return null;
  return info.titles.length > 0 ? info : null;
}


/**
 * Pays et langues du creneau couvert par cet addon.
 *
 * Volontairement l'Asie de l'Est et du Sud-Est : c'est ce que couvrent KissKH et
 * VoirDrama, et ce que le nom de l'addon annonce.
 */
const PAYS_ASIATIQUES = [
  'south korea', 'korea', 'china', 'japan', 'thailand', 'taiwan', 'hong kong',
  'indonesia', 'philippines', 'vietnam', 'malaysia', 'singapore',
];
const LANGUES_ASIATIQUES = new Set(['ko', 'zh', 'cn', 'ja', 'th', 'tl', 'id', 'vi', 'ms', 'yue']);

/**
 * Cette oeuvre releve-t-elle du creneau ?
 *
 * SANS CE GARDE-FOU, l'addon repondait sur TOUT : le manifeste declare `movie` et le
 * prefixe `tt`, donc Stremio l'interroge pour chaque titre, et les trackers FR
 * generalistes renvoyaient volontiers du Marvel — mesure : 10 flux sur Spider-Man,
 * 8 sur Barbie. Chacun de ces appels lançait un fan-out complet, scraping DDL compris,
 * et DEPOSAIT des magnets sur le compte AllDebrid de l'utilisateur pour verifier leur
 * disponibilite. Beaucoup de travail, et un compte pollue, pour du hors-sujet.
 *
 * Un id `kkh:` vient de notre propre catalogue : il est asiatique par construction.
 *
 * En cas de DOUTE — ni pays ni langue connus, ce qui arrive quand Cinemeta ne repond
 * pas — on repond OUI. Perdre un drama parce qu'une metadonnee manquait serait pire
 * que de faire une recherche inutile.
 */
export function estAsiatique(work: WorkInfo): boolean {
  if (work.kkhId) return true;

  const langue = (work.originalLanguage || '').toLowerCase();
  if (langue) return LANGUES_ASIATIQUES.has(langue);

  const pays = (work.country || '').toLowerCase();
  if (pays) return PAYS_ASIATIQUES.some((p) => pays.includes(p));

  return true;
}
