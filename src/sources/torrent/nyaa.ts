// Nyaa.si — la source torrent la plus pertinente pour ce creneau.
//
// Sa categorie « Live Action » (4_x) est l'endroit ou circulent les dramas asiatiques
// sous-titres, y compris par des teams francophones (sous-categorie 4_4,
// « non-english-translated »). Public, sans authentification, flux RSS stable, et le
// hash est fourni directement — donc rien a telecharger pour le connaitre.

import { getText } from '../../core/http';
import { cached } from '../../core/cache';
import { extractBlocks, tagText } from '../../core/xml';
import { makeEndpointConfig } from '../../core/endpoint-config';
import { matchesTitle } from '../../core/matching';
import { matchesEpisode, parseRelease } from './release';
import { episodeHint } from '../../debrid/types';
import type { Candidate, Query, SearchContext, Source } from '../types';

const TTL_MS = 30 * 60 * 1000;
const MAX_ITEMS = 60;

const endpoints = makeEndpointConfig('nyaa-endpoints.json', 'NYAA_ENDPOINTS_CONFIG', {
  base: 'https://nyaa.si',
});
export const reloadNyaaEndpoints = endpoints.reload;

export interface NyaaItem {
  title: string;
  infoHash: string;
  sizeBytes?: number;
  seeders?: number;
}

/** « 1.4 GiB » -> octets. Nyaa n'expose la taille que sous cette forme. */
export function parseSize(text: string | null): number | undefined {
  if (!text) return undefined;
  const m = text.trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/i);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return undefined;
  const factors: Record<string, number> = {
    b: 1,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  const factor = factors[m[2].toLowerCase()];
  return factor ? Math.round(value * factor) : undefined;
}

/** Analyse le RSS Nyaa. Pur : teste sans reseau. */
export function parseNyaaRss(xml: string): NyaaItem[] {
  const out: NyaaItem[] = [];
  for (const block of extractBlocks(xml, 'item').slice(0, MAX_ITEMS)) {
    const title = tagText(block, 'title');
    // Nyaa prefixe ses champs propres : <nyaa:infoHash>, <nyaa:seeders>, <nyaa:size>.
    const infoHash = (tagText(block, 'nyaa:infoHash') || '').toLowerCase();
    if (!title || !/^[a-f0-9]{40}$/.test(infoHash)) continue;

    const seeders = Number(tagText(block, 'nyaa:seeders') || '');
    out.push({
      title,
      infoHash,
      sizeBytes: parseSize(tagText(block, 'nyaa:size')),
      seeders: Number.isFinite(seeders) ? seeders : undefined,
    });
  }
  return out;
}

/**
 * Categories interrogees.
 *
 * 4_0 = Live Action (les dramas). 1_0 = Anime, ajoute seulement pour du contenu
 * japonais : sur un drama coreen, interroger la categorie anime ne ramene que du bruit
 * et consomme du budget.
 */
function categoriesFor(q: Query): string[] {
  const cats = ['4_0'];
  if (q.originalLanguage === 'ja') cats.push('1_0');
  return cats;
}

async function fetchRss(base: string, term: string, cat: string, signal?: AbortSignal): Promise<NyaaItem[]> {
  return cached<NyaaItem[]>(
    `nyaa:${cat}:${term.toLowerCase()}`,
    TTL_MS,
    async () => {
      const url = `${base}/?page=rss&c=${cat}&f=0&q=${encodeURIComponent(term)}`;
      const xml = await getText(url, { timeoutMs: 12000, signal, retries: 1, maxBytes: 4 * 1024 * 1024 });
      return xml ? parseNyaaRss(xml) : [];
    },
    { scope: 'nyaa', shouldCache: (v) => v.length > 0, negativeTtlMs: 10 * 60 * 1000 },
  );
}

/**
 * Termes de recherche.
 *
 * Nyaa n'indexe ni IMDb ni TMDB : seul le texte compte. On tente le titre nu, puis le
 * titre avec le motif d'episode — les teams nomment souvent « Titre - 09 » plutot que
 * « S01E09 », d'ou les deux formes.
 */
function termsFor(q: Query): string[] {
  const title = q.titles[0];
  if (!title) return [];
  const terms = [title];
  if (q.type === 'series' && q.episode) {
    terms.push(`${title} ${String(q.episode).padStart(2, '0')}`);
    if (q.season && q.season > 1) {
      terms.push(`${title} S${String(q.season).padStart(2, '0')}E${String(q.episode).padStart(2, '0')}`);
    }
  }
  return terms;
}

export const nyaaSource: Source = {
  id: 'nyaa',
  label: 'Nyaa',
  kind: 'torrent',
  needsDebrid: true,

  async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
    const base = String(endpoints.get().base).replace(/\/+$/, '');
    const hint = episodeHint(q.season, q.episode);
    const seen = new Set<string>();
    const out: Candidate[] = [];

    for (const cat of categoriesFor(q)) {
      for (const term of termsFor(q)) {
        if (ctx.deadline.remainingMs() < 1500) return out;
        const items = await fetchRss(base, term, cat, ctx.deadline.signal);

        for (const item of items) {
          if (seen.has(item.infoHash)) continue;
          seen.add(item.infoHash);

          // Le titre Nyaa porte le prefixe de la team : « [TeamFR] Squid Game - 09 ».
          // Le seuil est bas (0,55) parce que ce prefixe dilue mecaniquement le score,
          // et le controle d'episode qui suit rattrape les faux positifs.
          if (!matchesTitle(item.title, q.titles, { threshold: 0.55 })) continue;

          const parsed = parseRelease(item.title);
          if (!matchesEpisode(parsed, q.season, q.episode)) continue;

          out.push({
            sourceId: 'nyaa',
            kind: 'torrent',
            title: item.title,
            quality: parsed.quality,
            language: parsed.language,
            sizeBytes: item.sizeBytes,
            seeders: item.seeders,
            infoHash: item.infoHash,
            fileHint: parsed.isPack ? hint : undefined,
          });
        }
      }
    }
    return out;
  },
};
