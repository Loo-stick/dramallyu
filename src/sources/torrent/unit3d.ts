// Trackers bases sur UNIT3D — G3mini (Gemini) aujourd'hui.
//
// UNIT3D est une plateforme de tracker prive tres repandue, et son API est la meilleure
// que l'addon rencontre : la recherche se fait par IDENTIFIANT (tmdbId, imdbId) et non
// par titre. Aucune approximation de romanisation, aucun homonyme — un point qui compte
// particulierement ici, ou les titres asiatiques circulent sous trois formes.
//
// L'endpoint accepte aussi seasonNumber/episodeNumber, ce qui evite de ramener toute
// une serie pour un seul episode.

import { getSettings } from '../../core/settings';
import { cached } from '../../core/cache';
import { getJson } from '../../core/http';
import { parseRelease, matchesEpisode } from './release';
import { episodeHint } from '../../debrid/types';
import { completerHashes } from './torrentfile';
import type { Candidate, Query, SearchContext, Source } from '../types';

const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_PAR_PAGE = 100;

/**
 * Plafond de telechargements de .torrent par recherche.
 *
 * UNIT3D publie generalement le hash dans sa reponse ; ce plafond ne sert qu'aux
 * instances qui ne le font pas. Il reste bas : chaque unite est une requete HTTP de
 * plus dans un fan-out qui doit tenir sous quelques secondes.
 */
const MAX_TELECHARGEMENTS = 8;

interface ItemUnit3d {
  id?: number | string;
  attributes?: {
    name?: string;
    size?: number | string;
    seeders?: number | string;
    info_hash?: string;
    infoHash?: string;
    download_link?: string;
  };
  info_hash?: string;
  infoHash?: string;
}

function hashDe(item: ItemUnit3d): string | undefined {
  const brut = item.attributes?.info_hash ?? item.attributes?.infoHash ?? item.info_hash ?? item.infoHash;
  if (!brut) return undefined;
  const h = String(brut).trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(h) ? h : undefined;
}

function nombre(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Jeux de parametres a essayer, du plus precis au plus large.
 *
 * On interroge par TMDB **et** par IMDb : les trackers ne renseignent pas toujours les
 * deux, et une fiche qui n'a que l'un des identifiants serait invisible a l'autre. Les
 * doublons sont ecartes ensuite sur le hash.
 */
function requetesPour(q: Query): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const imdb = q.imdbId ? q.imdbId.replace(/^tt/, '') : undefined;

  if (q.type === 'series' && q.season !== undefined) {
    const saison: Record<string, string> = { seasonNumber: String(q.season) };
    const episode: Record<string, string> =
      q.episode !== undefined ? { episodeNumber: String(q.episode) } : {};
    if (q.tmdbId) out.push({ tmdbId: q.tmdbId, ...saison, ...episode });
    if (imdb) out.push({ imdbId: imdb, ...saison, ...episode });
    // Sans le numero d'episode : c'est ce qui ramene les PACKS de saison, souvent la
    // seule forme sous laquelle un drama complet est publie.
    if (q.episode !== undefined) {
      if (q.tmdbId) out.push({ tmdbId: q.tmdbId, ...saison });
      if (imdb) out.push({ imdbId: imdb, ...saison });
    }
  } else {
    if (q.tmdbId) out.push({ tmdbId: q.tmdbId });
    if (imdb) out.push({ imdbId: imdb });
  }
  return out;
}

async function interroger(
  id: string,
  base: string,
  apiKey: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<ItemUnit3d[]> {
  // La cle N'ENTRE PAS dans la cle de cache : deux utilisateurs du meme tracker
  // partagent le resultat, et aucun secret ne se retrouve ecrit sur disque.
  return cached<ItemUnit3d[]>(
    `unit3d:${id}:${JSON.stringify(params)}`,
    TTL_MS,
    async () => {
      const qs = new URLSearchParams({ perPage: String(MAX_PAR_PAGE), ...params });
      const data = await getJson<{ data?: unknown } | unknown[]>(`${base}/api/torrents/filter?${qs}`, {
        timeoutMs: 12000,
        signal,
        retries: 1,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      const brut = Array.isArray(data) ? data : ((data as { data?: unknown })?.data ?? []);
      return Array.isArray(brut) ? (brut.filter((x) => x && typeof x === 'object') as ItemUnit3d[]) : [];
    },
    { scope: 'unit3d', shouldCache: (v) => v.length > 0, negativeTtlMs: TTL_VIDE_MS },
  );
}

export function makeUnit3dSource(id: string, label: string, userKey: 'g3mini'): Source {
  return {
    id,
    label,
    kind: 'torrent',
    needsDebrid: true,
    requiredUserKey: userKey,

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const reglages = getSettings().unit3d?.[id];
      const apiKey = ctx.config[userKey];
      if (!reglages?.enabled || !apiKey) return [];

      const base = reglages.url.replace(/\/+$/, '');
      const hint = episodeHint(q.season, q.episode);

      const parHash = new Map<string, ItemUnit3d>();
      const sansHash: ItemUnit3d[] = [];

      for (const params of requetesPour(q)) {
        if (ctx.deadline.remainingMs() < 1500) break;
        for (const item of await interroger(id, base, apiKey, params, ctx.deadline.signal)) {
          const h = hashDe(item);
          if (h) {
            if (!parHash.has(h)) parHash.set(h, item);
          } else if (item.attributes?.download_link) {
            sansHash.push(item);
          }
        }
      }

      // Les entrees sans hash coutent un telechargement chacune : on ne s'y engage que
      // s'il reste du budget, et jamais au-dela du plafond.
      if (sansHash.length > 0 && ctx.deadline.remainingMs() > 3000) {
        const complets = await completerHashes(
          sansHash,
          MAX_TELECHARGEMENTS,
          (it) => (it.attributes?.download_link ? { url: it.attributes.download_link, cle: `${id}:${it.id}` } : null),
          (it) => Number(it.attributes?.seeders ?? 0),
          { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctx.deadline.signal },
        );
        for (const [item, h] of complets) if (!parHash.has(h)) parHash.set(h, item);
      }

      const out: Candidate[] = [];
      for (const [infoHash, item] of parHash) {
        const titre = item.attributes?.name;
        if (!titre) continue;

        // Pas de filtre sur le titre ici, contrairement au Torznab : la recherche s'est
        // faite par identifiant TMDB/IMDb, donc le tracker a deja repondu sur la bonne
        // oeuvre. Rejeter sur le titre ferait perdre les releases nommees dans une
        // romanisation qu'on ne connait pas — exactement ce qu'on cherche a eviter.
        const parsed = parseRelease(titre);
        if (!matchesEpisode(parsed, q.season, q.episode)) continue;

        out.push({
          sourceId: id,
          kind: 'torrent',
          title: titre,
          quality: parsed.quality,
          language: parsed.language,
          sizeBytes: nombre(item.attributes?.size),
          seeders: nombre(item.attributes?.seeders) ?? 0,
          infoHash,
          fileHint: parsed.isPack ? hint : undefined,
        });
      }
      return out;
    },
  };
}
