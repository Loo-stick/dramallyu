// Client Torznab generique.
//
// DECOUVERTE QUI A SIMPLIFIE TOUT LE PILIER : C411, Tr4ker et le relais Ygg ne sont
// pas des sites a scraper — ce sont tous les trois des endpoints **Torznab**
// (constate dans stream-fusion : meme namespace XML, meme parametre apikey). Un seul
// client les couvre donc tous, et ajouter un tracker devient une ligne de config a
// chaud au lieu d'un fichier de code.
//
// La CLE appartient a l'utilisateur, l'ADRESSE appartient a l'operateur : c'est la
// separation admin/configure du projet, appliquee ici.

import { getText } from '../../core/http';
import { cached } from '../../core/cache';
import { extractBlocks, tagText, attrOf, torznabAttrs } from '../../core/xml';
import { getSettings, type TorznabIndexerSettings } from '../../core/settings';
import { matchesTitle } from '../../core/matching';
import { matchesEpisode, parseRelease } from './release';
import { episodeHint } from '../../debrid/types';
import type { Candidate, Query, SearchContext, Source } from '../types';

const TTL_MS = 30 * 60 * 1000;
const MAX_ITEMS = 60;
const MAX_XML_BYTES = 4 * 1024 * 1024;

export interface TorznabItem {
  title: string;
  infoHash?: string;
  magnet?: string;
  sizeBytes?: number;
  seeders?: number;
}

/** Analyse une reponse Torznab. Pur : teste sans reseau. */
export function parseTorznab(xml: string): TorznabItem[] {
  const out: TorznabItem[] = [];

  for (const block of extractBlocks(xml, 'item').slice(0, MAX_ITEMS)) {
    const title = tagText(block, 'title');
    if (!title) continue;

    const attrs = torznabAttrs(block);
    const enclosure = attrOf(block, 'enclosure', 'url') || undefined;
    const link = tagText(block, 'link') || undefined;
    const magnet = [enclosure, link].find((u) => u && u.startsWith('magnet:'));

    let infoHash = attrs.infohash?.toLowerCase();
    if (!infoHash && magnet) {
      const m = magnet.match(/btih:([a-f0-9]{40})/i);
      if (m) infoHash = m[1].toLowerCase();
    }
    // Sans hash NI magnet, l'entree est inexploitable : le debrideur n'aurait rien a
    // se mettre sous la dent. Certains trackers privés ne donnent qu'un lien .torrent
    // signe par la cle — ils seront traites plus tard, pas silencieusement gardes ici.
    if (!infoHash && !magnet) continue;

    const sizeRaw = attrs.size || tagText(block, 'size');
    const size = sizeRaw ? Number(sizeRaw) : NaN;

    out.push({
      title,
      infoHash,
      magnet,
      sizeBytes: Number.isFinite(size) && size > 0 ? size : undefined,
      seeders: attrs.seeders !== undefined ? Number(attrs.seeders) || 0 : undefined,
    });
  }
  return out;
}

function buildUrl(
  settings: TorznabIndexerSettings,
  apiKey: string,
  params: Record<string, string>,
): string {
  const qs = new URLSearchParams({
    apikey: apiKey,
    cat: settings.categories.join(','),
    limit: String(MAX_ITEMS),
    ...params,
  });
  return `${settings.url.replace(/\/+$/, '')}?${qs.toString()}`;
}

/**
 * Requetes tentees, dans l'ordre.
 *
 * Quand on a un tmdbId, la recherche typee est nettement plus fiable qu'une recherche
 * texte : elle evite tout le probleme des titres asiatiques romanises. La recherche
 * par titre reste en repli, car tous les indexeurs n'indexent pas les identifiants.
 */
function queriesFor(q: Query): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const title = q.titles[0] || '';

  if (q.type === 'series') {
    if (q.tmdbId) {
      out.push({
        t: 'tvsearch',
        tmdbid: q.tmdbId,
        ...(q.season ? { season: String(q.season) } : {}),
        ...(q.episode ? { ep: String(q.episode) } : {}),
      });
    }
    if (title) out.push({ t: 'search', q: title });
  } else {
    if (q.tmdbId) out.push({ t: 'movie', tmdbid: q.tmdbId });
    if (title) out.push({ t: 'search', q: q.year ? `${title} ${q.year}` : title });
  }
  return out;
}

async function fetchItems(
  indexerId: string,
  settings: TorznabIndexerSettings,
  apiKey: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<TorznabItem[]> {
  // La cle N'ENTRE PAS dans la cle de cache : deux utilisateurs interrogeant le meme
  // tracker partagent le resultat, et aucune cle ne se retrouve ecrite sur disque.
  const cacheKey = `torznab:${indexerId}:${JSON.stringify(params)}`;
  return cached<TorznabItem[]>(
    cacheKey,
    TTL_MS,
    async () => {
      const xml = await getText(buildUrl(settings, apiKey, params), {
        timeoutMs: 12000,
        signal,
        retries: 1,
        maxBytes: MAX_XML_BYTES,
      });
      return xml ? parseTorznab(xml) : [];
    },
    { scope: 'torznab', shouldCache: (v) => v.length > 0, negativeTtlMs: 10 * 60 * 1000 },
  );
}

function makeSource(id: string, label: string, userKey: 'c411' | 'tr4ker'): Source {
  return {
    id,
    label,
    kind: 'torrent',
    needsDebrid: true,
    requiredUserKey: userKey,

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const indexer = getSettings().torznab[id];
      const apiKey = ctx.config[userKey];
      if (!indexer?.enabled || !apiKey) return [];

      const hint = episodeHint(q.season, q.episode);
      const seen = new Set<string>();
      const out: Candidate[] = [];

      for (const params of queriesFor(q)) {
        if (ctx.deadline.remainingMs() < 1500) break;
        const items = await fetchItems(id, indexer, apiKey, params, ctx.deadline.signal);

        for (const item of items) {
          const key = item.infoHash || item.magnet || item.title;
          if (seen.has(key)) continue;
          seen.add(key);

          // Un indexeur renvoie du bruit : sans ce filtre, une recherche « Signal »
          // ramene tous les torrents dont le titre contient ce mot.
          if (!matchesTitle(item.title, q.titles, { year: q.year, threshold: 0.6 })) continue;

          const parsed = parseRelease(item.title);
          if (!matchesEpisode(parsed, q.season, q.episode)) continue;

          out.push({
            sourceId: id,
            kind: 'torrent',
            title: item.title,
            quality: parsed.quality,
            language: parsed.language,
            sizeBytes: item.sizeBytes,
            seeders: item.seeders,
            infoHash: item.infoHash,
            magnet: item.magnet,
            // Sur un pack de saison, c'est cet indice qui permet au debrideur de
            // choisir le bon fichier dans le dossier.
            fileHint: parsed.isPack ? hint : undefined,
          });
        }
      }
      return out;
    },
  };
}

/** Les indexeurs Torznab declares dans les reglages operateur. */
export function torznabSources(): Source[] {
  return [makeSource('c411', 'C411', 'c411'), makeSource('tr4ker', 'Tr4ker', 'tr4ker')];
}
