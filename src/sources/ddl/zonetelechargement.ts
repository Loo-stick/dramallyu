// Zone-Telechargement — pilier DDL.
//
// Structure relevee sur le site le 2026-08-12 (et non devinee) :
//
//   - Recherche : POST DataLife Engine sur /index.php
//       do=search&subaction=search&story=<titre>
//     (le formulaire GET ne renvoie rien : c'est le piege du site.)
//   - Fiche : l'hebergeur est annonce par une IMAGE, `<img src='/img/1fichier.png'>`,
//     suivie de la liste des liens de la forme
//       <a class="btnToLink" href="//zoneurs.net/?url=TOKEN">Episode 3</a>
//   - Le lien passe par un protecteur (zoneurs.net) qu'il faut ouvrir pour obtenir
//     la vraie URL 1fichier / uptobox, celle qu'on donne ensuite au debrideur.
//
// Le domaine du site tourne beaucoup : il est en hot-reload, editable par l'admin.

import { getText, postForm } from '../../core/http';
import { cached } from '../../core/cache';
import { makeEndpointConfig } from '../../core/endpoint-config';
import { matchesTitle } from '../../core/matching';
import { parseRelease } from '../torrent/release';
import type { Candidate, Query, SearchContext, Source } from '../types';

const TTL_MS = 60 * 60 * 1000;
const EMPTY_TTL_MS = 10 * 60 * 1000;
const MAX_FICHES = 3;
const MAX_LINKS = 4;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

const endpoints = makeEndpointConfig(
  'zonetelechargement-endpoints.json',
  'ZONETELECHARGEMENT_ENDPOINTS_CONFIG',
  { base: 'https://zone-telechargement.org' },
);
export const reloadZtEndpoints = endpoints.reload;

const BASE = (): string => String(endpoints.get().base).replace(/\/+$/, '');

/** Hebergeurs qu'AllDebrid et TorBox savent debloquer. */
const SUPPORTED_HOSTS = ['1fichier', 'uptobox', 'rapidgator', 'turbobit', 'nitroflare', 'uploady'];

export interface ZtLink {
  host: string;
  protectedUrl: string;
  episode: number | null;
}

/**
 * Extrait les liens d'une fiche, groupes par hebergeur.
 *
 * L'analyse est SEQUENTIELLE : on avance dans la page, chaque image d'hebergeur
 * ouvre un bloc, et tous les liens suivants lui appartiennent jusqu'a l'image
 * suivante. C'est fidele a la structure reelle du site, ou rien n'imbrique
 * explicitement les liens sous leur hebergeur.
 */
export function parseFicheLinks(html: string): ZtLink[] {
  const out: ZtLink[] = [];
  let currentHost = 'inconnu';
  let i = 0;

  while (i < html.length) {
    const imgAt = html.indexOf('/img/', i);
    const linkAt = html.indexOf('/?url=', i);

    if (linkAt === -1) break;

    // L'image d'hebergeur precede-t-elle le prochain lien ? Alors elle change le bloc.
    if (imgAt !== -1 && imgAt < linkAt) {
      const end = html.indexOf('.png', imgAt);
      if (end !== -1 && end - imgAt < 40) {
        const name = html.slice(imgAt + 5, end).toLowerCase();
        if (SUPPORTED_HOSTS.some((h) => name.includes(h))) currentHost = name;
      }
      i = imgAt + 5;
      continue;
    }

    // Un lien : on remonte a l'ouverture du href et on lit le libelle qui suit.
    const quoteStart = html.lastIndexOf('"', linkAt);
    const quoteEnd = html.indexOf('"', linkAt);
    if (quoteStart === -1 || quoteEnd === -1) break;

    let url = html.slice(quoteStart + 1, quoteEnd).replace(/&amp;/g, '&');
    if (url.startsWith('//')) url = `https:${url}`;

    const labelStart = html.indexOf('>', quoteEnd);
    const labelEnd = labelStart === -1 ? -1 : html.indexOf('<', labelStart);
    const label = labelStart !== -1 && labelEnd !== -1 ? html.slice(labelStart + 1, labelEnd) : '';
    const epMatch = label.match(/episode\s*0*(\d{1,3})/i);

    if (/^https:\/\/[a-z0-9][a-z0-9.-]*\/\?url=/.test(url)) {
      out.push({
        host: currentHost,
        protectedUrl: url,
        episode: epMatch ? Number(epMatch[1]) : null,
      });
    }
    i = quoteEnd + 1;
  }
  return out;
}

/** Recherche DLE. Le POST est indispensable : le GET ne renvoie aucun resultat. */
async function searchFiches(title: string, signal?: AbortSignal): Promise<string[]> {
  return cached<string[]>(
    `zt:search:${title.toLowerCase()}`,
    TTL_MS,
    async () => {
      const html = await postForm(
        `${BASE()}/index.php`,
        { do: 'search', subaction: 'search', story: title },
        { timeoutMs: 20000, signal, maxBytes: MAX_HTML_BYTES },
      );
      if (!html) return [];

      const urls = new Set<string>();
      let i = 0;
      while ((i = html.indexOf('-telecharger-', i)) !== -1) {
        const start = html.lastIndexOf('"', i);
        const end = html.indexOf('"', i);
        if (start === -1 || end === -1) break;
        const u = html.slice(start + 1, end);
        if (/^https?:\/\/.+\.html$/.test(u)) urls.add(u);
        i = end + 1;
      }
      return [...urls].slice(0, MAX_FICHES * 2);
    },
    { scope: 'zt', shouldCache: (v) => v.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

/**
 * Ouvre le protecteur pour obtenir la vraie URL d'hebergeur.
 *
 * Un appel reseau par lien : c'est cher, donc on le fait au plus tard et sur peu de
 * liens. Le budget du fan-out est verifie avant chaque resolution.
 */
async function resolveProtected(url: string, signal?: AbortSignal): Promise<string | null> {
  return cached<string | null>(
    `zt:prot:${url}`,
    6 * 60 * 60 * 1000,
    async () => {
      const html = await getText(url, {
        timeoutMs: 15000,
        signal,
        headers: { Referer: `${BASE()}/` },
        maxBytes: 1024 * 1024,
      });
      if (!html) return null;
      for (const m of html.matchAll(/https?:\/\/[a-z0-9.-]+\/[^\s"'<>]+/gi)) {
        const candidate = m[0];
        if (SUPPORTED_HOSTS.some((h) => candidate.toLowerCase().includes(h))) return candidate;
      }
      return null;
    },
    { scope: 'zt', shouldCache: (v) => v !== null, negativeTtlMs: 30 * 60 * 1000 },
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'inconnu';
  }
}

async function searchZt(q: Query, ctx: SearchContext): Promise<Candidate[]> {
  const title = q.titles[0];
  if (!title) return [];

  const fiches = await searchFiches(title, ctx.deadline.signal);
  const out: Candidate[] = [];

  for (const fiche of fiches.slice(0, MAX_FICHES)) {
    if (ctx.deadline.remainingMs() < 2500) break;

    // Le titre de la fiche est dans son slug : on filtre AVANT d'ouvrir la page, ce
    // qui evite d'en telecharger trois pour rien.
    const slug = fiche.split('/').pop() || '';
    const readable = slug.replace(/^\d+-telecharger-/, '').replace(/\.html$/, '').replace(/-/g, ' ');
    if (!matchesTitle(readable, q.titles, { threshold: 0.6 })) continue;

    const html = await getText(fiche, {
      timeoutMs: 20000,
      signal: ctx.deadline.signal,
      maxBytes: MAX_HTML_BYTES,
    });
    if (!html) continue;

    const parsed = parseRelease(readable);
    const links = parseFicheLinks(html).filter((l) => {
      if (q.type === 'movie' || q.episode === undefined) return true;
      // Un lien sans numero d'episode sur une fiche de serie est ambigu : on l'ecarte
      // plutot que de risquer de servir le mauvais episode.
      return l.episode === q.episode;
    });

    for (const link of links.slice(0, MAX_LINKS)) {
      if (ctx.deadline.remainingMs() < 2000) break;
      const real = await resolveProtected(link.protectedUrl, ctx.deadline.signal);
      if (!real) continue;

      out.push({
        sourceId: 'zonetelechargement',
        kind: 'ddl',
        title: readable.trim(),
        quality: parsed.quality,
        language: parsed.language,
        ddlUrl: real,
        ddlHost: hostOf(real),
      });
    }
  }
  return out;
}

export const zoneTelechargementSource: Source = {
  id: 'zonetelechargement',
  label: 'Zone-Telechargement',
  kind: 'ddl',
  needsDebrid: true,
  search: searchZt,
};
