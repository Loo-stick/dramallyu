// Sous-titres FR externes via l'API LEGACY d'OpenSubtitles.
//
// `rest.opensubtitles.org` : SANS cle, SANS quota, liens de telechargement directs.
// Surtout PAS l'API v1 (api.opensubtitles.com), qui exige une cle et impose un quota
// journalier — ce serait une cle de plus a demander a chaque utilisateur, pour un
// service que la version legacy rend gratuitement.
//
// Utile ici parce que le catalogue de dramas est mal couvert en FR : quand KissKH n'a
// pas de piste francaise sur un episode, OpenSubtitles en a parfois une.

import { httpGet } from '../core/http';
import { cached } from '../core/cache';
import type { SubTrack } from '../sources/types';

const BASE = 'https://rest.opensubtitles.org';
// L'API legacy REJETTE les requetes sans User-Agent identifiable.
const UA = 'Dramallyu/0.1 (+subtitles)';
const TTL_MS = 12 * 60 * 60 * 1000;
const TOP_N = 5;

interface OsItem {
  SubDownloadLink?: string;
  SubFileName?: string;
  MovieReleaseName?: string;
  SubFormat?: string;
  SubDownloadsCnt?: string;
  SubLanguageID?: string;
}

/** Pur : filtre les formats texte, trie par popularite, garde les meilleurs. */
export function parseOpenSubtitles(data: unknown, lang: string): SubTrack[] {
  if (!Array.isArray(data)) return [];
  const isText = (s: OsItem): boolean => {
    const fmt = String(s.SubFormat || '');
    const name = String(s.SubFileName || '');
    // L'ASS est frequent sur les teams asiatiques : on l'accepte, la conversion en
    // VTT est faite au moment de servir.
    return /(srt|ass|ssa|vtt)/i.test(fmt) || /\.(srt|ass|ssa|vtt)$/i.test(name);
  };

  return (data as OsItem[])
    .filter((s) => s.SubDownloadLink && isText(s))
    .sort((a, b) => Number(b.SubDownloadsCnt || 0) - Number(a.SubDownloadsCnt || 0))
    .slice(0, TOP_N)
    .map((s) => ({
      url: String(s.SubDownloadLink),
      lang,
      label: `OpenSubtitles - ${s.SubFileName || s.MovieReleaseName || 'sous-titre'}`,
    }));
}

/**
 * Cherche par identifiant IMDb. Sans imdbId on ne cherche pas : la recherche par
 * titre d'OpenSubtitles est catastrophique sur les titres asiatiques romanises et
 * renverrait des sous-titres d'une autre oeuvre.
 */
export async function findSubtitles(
  imdbId: string | undefined,
  lang: string,
  season?: number,
  episode?: number,
  signal?: AbortSignal,
): Promise<SubTrack[]> {
  const num = String(imdbId || '').replace(/^tt/i, '');
  if (!/^\d+$/.test(num)) return [];

  const path =
    season && episode
      ? `/search/episode-${episode}/imdbid-${num}/season-${season}/sublanguageid-${lang}`
      : `/search/imdbid-${num}/sublanguageid-${lang}`;

  return cached<SubTrack[]>(
    `os:${lang}:${num}:${season || ''}:${episode || ''}`,
    TTL_MS,
    async () => {
      const res = await httpGet(`${BASE}${path}`, {
        headers: { 'User-Agent': UA },
        timeoutMs: 10000,
        signal,
        retries: 1,
      });
      if (!res || res.status !== 200) return [];
      return parseOpenSubtitles(res.data, lang);
    },
    { scope: 'opensubtitles', shouldCache: (v) => v.length > 0, negativeTtlMs: 60 * 60 * 1000 },
  );
}
