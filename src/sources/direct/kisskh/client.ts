// Client de l'API KissKH.
//
// Trois endpoints sont OUVERTS (recherche, fiche, catalogue pagine) et deux sont
// SIGNES (video, sous-titres). Cette separation structure tout le fichier : le
// catalogue de l'addon ne depend jamais de la signature, donc il continue de
// fonctionner meme le jour ou KissKH casse le kkey.

import { getJson, httpGet } from '../../../core/http';
import { cached } from '../../../core/cache';
import { constants, videoKey, subKey, noteForbidden } from './kkey';

const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const DRAMA_TTL_MS = 12 * 60 * 60 * 1000;
const LIST_TTL_MS = 3 * 60 * 60 * 1000;
const VIDEO_TTL_MS = 20 * 60 * 1000;
const SUBS_TTL_MS = 60 * 60 * 1000;

function api(): string {
  return `${constants().base}/api`;
}

function headers(): Record<string, string> {
  return { Referer: `${constants().base}/`, Accept: 'application/json' };
}

export interface KkSearchItem {
  id: number;
  title: string;
  thumbnail: string;
  episodesCount: number;
}

export interface KkEpisode {
  id: number;
  number: number;
  sub: number;
}

export interface KkDrama {
  id: number;
  title: string;
  description: string;
  releaseDate: string;
  country: string;
  status: string;
  type: string;
  thumbnail: string;
  episodesCount: number;
  episodes: KkEpisode[];
}

export interface KkSubtitle {
  src: string;
  label: string;
  /** ISO 639-1 renvoye par KissKH ("en", "fr", "km"...). */
  land: string;
  default: boolean;
}

export interface KkVideo {
  Video: string | null;
  ThirdParty: string | null;
  Type: number | null;
}

/** Recherche par titre. Endpoint ouvert. */
export async function search(query: string, signal?: AbortSignal): Promise<KkSearchItem[]> {
  const q = query.trim();
  if (!q) return [];
  return cached<KkSearchItem[]>(
    `kisskh:search:${q.toLowerCase()}`,
    SEARCH_TTL_MS,
    async () => {
      const data = await getJson<KkSearchItem[]>(
        `${api()}/DramaList/Search?q=${encodeURIComponent(q)}&type=`,
        { headers: headers(), signal, timeoutMs: 12000 },
      );
      return Array.isArray(data) ? data : [];
    },
    { scope: 'kisskh', shouldCache: (v) => v.length > 0, negativeTtlMs: 30 * 60 * 1000 },
  );
}

/** Fiche complete (metadonnees + liste des episodes). Endpoint ouvert. */
export async function drama(id: number | string, signal?: AbortSignal): Promise<KkDrama | null> {
  return cached<KkDrama | null>(
    `kisskh:drama:${id}`,
    DRAMA_TTL_MS,
    async () => {
      const data = await getJson<KkDrama>(`${api()}/DramaList/Drama/${id}?isq=false`, {
        headers: headers(),
        signal,
        timeoutMs: 12000,
      });
      if (!data || !data.title) return null;
      // Les episodes arrivent en ordre decroissant : on remet en ordre naturel une
      // bonne fois pour toutes, sinon chaque appelant doit y penser.
      if (Array.isArray(data.episodes)) {
        data.episodes = [...data.episodes].sort((a, b) => a.number - b.number);
      } else {
        data.episodes = [];
      }
      return data;
    },
    { scope: 'kisskh', shouldCache: (v) => v !== null, negativeTtlMs: 30 * 60 * 1000 },
  );
}

export interface ListParams {
  page?: number;
  pageSize?: number;
  /** 0 = tout, 1 = drama, 2 = film... (voir docs/kisskh-api.md) */
  type?: number;
  sub?: number;
  /** Pays : 0 = tout. */
  country?: number;
  status?: number;
  /** 1 = populaire, 2 = recent... */
  order?: number;
}

export interface KkList {
  page: number;
  pageSize: number;
  totalCount: number;
  data: KkSearchItem[];
}

/** Catalogue pagine. Endpoint OUVERT : c'est le socle du catalogue de l'addon. */
export async function list(params: ListParams = {}, signal?: AbortSignal): Promise<KkList> {
  const p = {
    page: params.page ?? 1,
    pageSize: params.pageSize ?? 40,
    type: params.type ?? 0,
    sub: params.sub ?? 0,
    country: params.country ?? 0,
    status: params.status ?? 0,
    order: params.order ?? 1,
  };
  const key = `kisskh:list:${Object.values(p).join(':')}`;
  return cached<KkList>(
    key,
    LIST_TTL_MS,
    async () => {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])),
      ).toString();
      const data = await getJson<KkList>(`${api()}/DramaList/List?${qs}`, {
        headers: headers(),
        signal,
        timeoutMs: 15000,
      });
      if (!data || !Array.isArray(data.data)) {
        return { page: p.page, pageSize: p.pageSize, totalCount: 0, data: [] };
      }
      return data;
    },
    { scope: 'kisskh', shouldCache: (v) => v.data.length > 0, negativeTtlMs: 15 * 60 * 1000 },
  );
}

/**
 * URL video d'un episode. ENDPOINT SIGNE.
 *
 * Un 403 ici n'est pas une erreur ordinaire : il signale que notre signature n'est
 * plus acceptee. On le remonte a kkey.ts, qui declenche une re-decouverte au bout de
 * quelques occurrences rapprochees.
 */
export async function episodeVideo(
  episodeId: number,
  signal?: AbortSignal,
): Promise<KkVideo | null> {
  return cached<KkVideo | null>(
    `kisskh:video:${episodeId}`,
    VIDEO_TTL_MS,
    async () => {
      const kkey = await videoKey(episodeId);
      if (!kkey) return null;
      const url = `${api()}/DramaList/Episode/${episodeId}.png?err=false&ts=null&time=null&kkey=${kkey}`;
      const res = await httpGet<KkVideo>(url, { headers: headers(), signal, timeoutMs: 15000 });
      if (!res) return null;
      if (res.status === 403) {
        noteForbidden();
        return null;
      }
      if (res.status < 200 || res.status >= 300) return null;
      const data = res.data;
      if (!data || (!data.Video && !data.ThirdParty)) return null;
      return data;
    },
    { scope: 'kisskh', shouldCache: (v) => v !== null, negativeTtlMs: 3 * 60 * 1000 },
  );
}

/** Pistes de sous-titres d'un episode. ENDPOINT SIGNE. */
export async function episodeSubs(
  episodeId: number,
  signal?: AbortSignal,
): Promise<KkSubtitle[]> {
  return cached<KkSubtitle[]>(
    `kisskh:subs:${episodeId}`,
    SUBS_TTL_MS,
    async () => {
      const kkey = await subKey(episodeId);
      if (!kkey) return [];
      const res = await httpGet<KkSubtitle[]>(`${api()}/Sub/${episodeId}?kkey=${kkey}`, {
        headers: headers(),
        signal,
        timeoutMs: 15000,
      });
      if (!res) return [];
      if (res.status === 403) {
        noteForbidden();
        return [];
      }
      if (res.status < 200 || res.status >= 300) return [];
      return Array.isArray(res.data) ? res.data : [];
    },
    { scope: 'kisskh', shouldCache: (v) => v.length > 0, negativeTtlMs: 10 * 60 * 1000 },
  );
}
