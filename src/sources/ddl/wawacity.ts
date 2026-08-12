// Wawacity — deuxieme source DDL, redondance de Zone-Telechargement.
//
// ETAT AU 2026-08-12, a lire avant de s'en servir : aucun domaine wawacity vivant
// n'a pu etre joint depuis le serveur. `wawacity.pro` est un domaine PARQUE — il
// redirige vers une regie publicitaire (`sk-park.php`) — et les autres extensions
// testees ne resolvent pas (domaine mort, ou blocage DNS du fournisseur).
//
// Cette source est donc livree **desactivee par defaut** dans les reglages. Elle
// s'active en une ligne d'admin des que l'operateur connait le domaine courant :
//   config/wawacity-endpoints.json  ->  { "base": "https://wawacity.<tld>" }
//   config/runtime-settings.json    ->  { "sources": { "wawacity": true } }
//
// Ce qui EST verifie et implemente ici : le portillon FingerprintJS du site. Il ne
// s'agit pas d'un contournement d'anti-bot mais du chemin `noscript` que le site
// publie lui-meme — une page intermediaire annonce `redirect_link` et un parametre
// `fp`, avec la valeur de repli `-5` prevue pour les clients sans JavaScript.

import { getText } from '../../core/http';
import { cached } from '../../core/cache';
import { makeEndpointConfig } from '../../core/endpoint-config';
import { matchesTitle } from '../../core/matching';
import { parseRelease } from '../torrent/release';
import type { Candidate, Query, SearchContext, Source } from '../types';

const TTL_MS = 60 * 60 * 1000;
const EMPTY_TTL_MS = 15 * 60 * 1000;
const MAX_FICHES = 3;
const MAX_LINKS = 4;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

const endpoints = makeEndpointConfig('wawacity-endpoints.json', 'WAWACITY_ENDPOINTS_CONFIG', {
  base: 'https://wawacity.pro',
});
export const reloadWawacityEndpoints = endpoints.reload;

const BASE = (): string => String(endpoints.get().base).replace(/\/+$/, '');

const SUPPORTED_HOSTS = ['1fichier', 'uptobox', 'rapidgator', 'turbobit', 'nitroflare'];

/** Signature d'un domaine parqué : mieux vaut rendre zero que du contenu publicitaire. */
export function looksParked(html: string): boolean {
  return /sk-park\.php|"mode":"iframe"|domain (?:is )?for sale|parking/i.test(html.slice(0, 4000));
}

/**
 * Franchit le portillon.
 *
 * La page intermediaire porte `redirect_link = '<url>'` et attend un parametre `fp`.
 * On emprunte la valeur de repli sans JavaScript que le site publie lui-meme.
 */
export function gateTarget(html: string): string | null {
  const m = html.match(/redirect_link\s*=\s*['"]([^'"]+)['"]/);
  if (!m) return null;
  const base = m[1];
  return base.endsWith('&') || base.endsWith('?') ? `${base}fp=-5` : `${base}&fp=-5`;
}

async function fetchThroughGate(url: string, signal?: AbortSignal): Promise<string | null> {
  const first = await getText(url, { timeoutMs: 20000, signal, maxBytes: MAX_HTML_BYTES });
  if (!first) return null;
  if (looksParked(first)) {
    console.log('[Wawacity] domaine parqué — source ignorée (mettre a jour wawacity-endpoints.json)');
    return null;
  }

  const target = gateTarget(first);
  if (!target) return first; // pas de portillon : la page est deja la bonne

  const second = await getText(target, {
    timeoutMs: 20000,
    signal,
    maxBytes: MAX_HTML_BYTES,
    headers: { Referer: url },
  });
  if (!second || looksParked(second)) return null;
  return second;
}

/** Liens de fiches d'une page de resultats. */
export function parseSearchResults(html: string): string[] {
  const out = new Set<string>();
  let i = 0;
  while ((i = html.indexOf('?p=', i)) !== -1) {
    const start = html.lastIndexOf('"', i);
    const end = html.indexOf('"', i);
    if (start === -1 || end === -1) break;
    const u = html.slice(start + 1, end);
    // Les fiches wawacity portent un identifiant : ?p=serie-12345 ou ?p=film-12345.
    if (/^\??p=(?:film|serie)-\d+/.test(u.replace(/^[./]*/, '')) || /[?&]p=(?:film|serie)-\d+/.test(u)) {
      out.add(u);
    }
    i = end + 1;
  }
  return [...out].slice(0, MAX_FICHES * 2);
}

/** Liens d'hebergeur d'une fiche, avec leur numero d'episode quand il est annonce. */
export function parseHosterLinks(html: string): { url: string; episode: number | null }[] {
  const out: { url: string; episode: number | null }[] = [];
  const seen = new Set<string>();
  let i = 0;

  while ((i = html.indexOf('href="', i)) !== -1) {
    const end = html.indexOf('"', i + 6);
    if (end === -1) break;
    const url = html.slice(i + 6, end).replace(/&amp;/g, '&');
    i = end + 1;

    if (!SUPPORTED_HOSTS.some((h) => url.toLowerCase().includes(h))) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // Le libelle voisin porte generalement « Episode N ».
    const labelStart = html.indexOf('>', end);
    const labelEnd = labelStart === -1 ? -1 : html.indexOf('<', labelStart);
    const label = labelStart !== -1 && labelEnd !== -1 ? html.slice(labelStart + 1, labelEnd) : '';
    const ep = label.match(/episode\s*0*(\d{1,3})/i);

    out.push({ url, episode: ep ? Number(ep[1]) : null });
  }
  return out;
}

function absolute(u: string): string {
  if (/^https?:\/\//.test(u)) return u;
  return `${BASE()}/${u.replace(/^[./]+/, '')}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'inconnu';
  }
}

async function searchWawacity(q: Query, ctx: SearchContext): Promise<Candidate[]> {
  const title = q.titles[0];
  if (!title) return [];

  const section = q.type === 'series' ? 'serie' : 'film';
  const searchUrl = `${BASE()}/?p=${section}&search=${encodeURIComponent(title)}`;

  const results = await cached<string[]>(
    `wawa:search:${section}:${title.toLowerCase()}`,
    TTL_MS,
    async () => {
      const html = await fetchThroughGate(searchUrl, ctx.deadline.signal);
      return html ? parseSearchResults(html) : [];
    },
    { scope: 'wawacity', shouldCache: (v) => v.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );

  const out: Candidate[] = [];
  for (const fiche of results.slice(0, MAX_FICHES)) {
    if (ctx.deadline.remainingMs() < 2500) break;

    const html = await fetchThroughGate(absolute(fiche), ctx.deadline.signal);
    if (!html) continue;

    const heading = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1]?.trim() || title;
    if (!matchesTitle(heading, q.titles, { threshold: 0.6 })) continue;

    const parsed = parseRelease(heading);
    const links = parseHosterLinks(html).filter((l) => {
      if (q.type === 'movie' || q.episode === undefined) return true;
      return l.episode === q.episode;
    });

    for (const link of links.slice(0, MAX_LINKS)) {
      out.push({
        sourceId: 'wawacity',
        kind: 'ddl',
        title: heading,
        quality: parsed.quality,
        language: parsed.language,
        ddlUrl: link.url,
        ddlHost: hostOf(link.url),
      });
    }
  }
  return out;
}

export const wawacitySource: Source = {
  id: 'wawacity',
  label: 'Wawacity',
  kind: 'ddl',
  needsDebrid: true,
  search: searchWawacity,
};
