// VoirDrama — dramas asiatiques sous-titres en francais.
//
// Porte de LooStream, adapte au contrat Source. Deux chemins complementaires, et
// l'ordre compte :
//
//  1. L'API Movix, keyee par tmdbId : une seule requete, AUCUNE correspondance de
//     titre a faire, donc aucun risque de servir le mauvais drama. Series uniquement.
//  2. Le scraping du site (WordPress/theme Madara), en repli : il couvre les films,
//     la VF, et les fiches que l'API rate.
//
// Le repli n'est tente que pour du contenu ASIATIQUE : quand l'API repond « pas
// trouve » sur un titre occidental, c'est une reponse fiable et scraper derriere ne
// ferait que gaspiller du budget.

import { getText, getJson } from '../../core/http';
import { cached } from '../../core/cache';
import { makeEndpointConfig } from '../../core/endpoint-config';
import { extractStream, detectExtractor, type ExtractorConfig } from '../../extractors';
import { mediaflowConfig } from '../../core/mediaflow';
import { normalizeTitle } from '../../core/matching';
import { mesurerQualite } from '../../core/resolution';
import { isUnknownQuality } from '../../core/prefs';
import type { Candidate, Query, SearchContext, Source } from '../types';

const TTL_MS = 15 * 60 * 1000;
const EMPTY_TTL_MS = 5 * 60 * 1000;
const MAX_EXTRACTIONS = 4;
const MAX_VARIANTS = 2;

const siteEndpoints = makeEndpointConfig('voirdrama-endpoints.json', 'VOIRDRAMA_ENDPOINTS_CONFIG', {
  base: 'https://voirdrama.to',
  movixApi: 'https://api.movix.show',
  movixReferer: 'https://movix.cash/',
});
export const reloadVoirDramaEndpoints = siteEndpoints.reload;

const SITE_BASE = (): string => String(siteEndpoints.get().base).replace(/\/+$/, '');

// Motifs repris du provider Onyx : les lecteurs sont dans un blob JSON de la page de
// lecture, sous des cles contenant « LECTEUR ».
const PLAYER_RX = /"([^"]*LECTEUR[^"]*)"\s*:\s*"(?:[^"\\]|\\.)*?src=\\?["']?(https?:(?:[^"'\\\s]|\\\/)+)/g;
const SEARCH_ITEM_RX = /<h3[^>]*>\s*<a\s+href="(https?:\/\/[a-z0-9.-]+\/drama\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
const CHAPTER_RX =
  /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]{0,300}?<a\s+href="(https?:\/\/[a-z0-9.-]+\/drama\/[^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g;

/** Le suffixe « -vf » du slug porte la langue ; par defaut le site est sous-titre. */
function languageOf(url: string, title: string): string {
  const slug = url.replace(/\/+$/, '').split('/').pop() || '';
  if (/-vf$/.test(slug) || /\(\s*vf\s*\)/i.test(title)) return 'VF';
  return 'VOSTFR';
}

function seasonOf(url: string, title: string): number {
  const hay = `${url} ${title}`;
  const m =
    hay.match(/sais?on[\s-]*0*(\d+)/i) ||
    hay.match(/season[\s-]*0*(\d+)/i) ||
    // Certains dramas encodent la saison ainsi : « Weak Hero Class 1 / Class 2 ».
    hay.match(/\bclass[\s-]*0*(\d+)/i);
  return m ? Number(m[1]) : 1;
}

function episodeNumberOf(label: string, url: string): number | null {
  const slug = url.replace(/\/+$/, '').split('/').pop() || '';

  const kw = label.match(/(?:épisode|episode|ep)\s*0*(\d+)/i) || slug.match(/-(?:episode|ep)-0*(\d+)/i);
  if (kw) return Number(kw[1]);

  // « …-08-vf » / « …-08 », mais pas « …-2005-film-vf » : d'ou la limite a 3 chiffres.
  const fromSlug = slug.match(/-0*(\d{1,3})(?:-(?:vf|vostfr|vost|vo|multi))?$/i);
  if (fromSlug) return Number(fromSlug[1]);

  const fromLabel = label.match(/(?:^|[\s-])0*(\d{1,3})\s*$/);
  return fromLabel ? Number(fromLabel[1]) : null;
}

function serverName(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/(^|\.)mail\.ru$/.test(h)) return 'mailru';
    if (/(^|\.)ok\.ru$/.test(h)) return 'okru';
    return h.split('.')[0] || 'voirdrama';
  } catch {
    return 'voirdrama';
  }
}

interface Embed {
  url: string;
  server: string;
}

interface Fiche {
  url: string;
  title: string;
  language: string;
}

async function searchSite(title: string, season: number | undefined, signal?: AbortSignal): Promise<Fiche[]> {
  const html = await getText(`${SITE_BASE()}/?s=${encodeURIComponent(title)}&post_type=wp-manga`, {
    timeoutMs: 15000,
    signal,
  });
  if (!html) return [];

  const target = normalizeTitle(title);
  const found: Fiche[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(SEARCH_ITEM_RX)) {
    const url = m[1];
    const name = m[2].trim();
    if (seen.has(url)) continue;
    seen.add(url);

    const norm = normalizeTitle(name);
    // Correspondance stricte ou par inclusion : les fiches ajoutent souvent un
    // sous-titre, mais on refuse le vague.
    if (!norm || (norm !== target && !norm.startsWith(target) && !target.startsWith(norm))) continue;
    // Chaque saison est une fiche distincte : servir la saison 1 a qui demande la 2
    // est pire que ne rien servir.
    if (season !== undefined && seasonOf(url, name) !== season) continue;

    found.push({ url, title: name, language: languageOf(url, name) });
  }

  // Une seule fiche par langue, la correspondance la plus proche.
  const byLang = new Map<string, Fiche>();
  for (const f of found.sort((a, b) => normalizeTitle(a.title).length - normalizeTitle(b.title).length)) {
    if (!byLang.has(f.language)) byLang.set(f.language, f);
  }
  return [...byLang.values()].slice(0, MAX_VARIANTS);
}

async function findReadingPage(
  ficheUrl: string,
  episode: number | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  const html = await getText(ficheUrl, { timeoutMs: 15000, signal });
  if (!html) return null;

  const chapters: { url: string; label: string }[] = [];
  for (const m of html.matchAll(CHAPTER_RX)) {
    chapters.push({
      url: m[1],
      label: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  }
  if (chapters.length === 0) return null;
  if (!episode) return chapters[0].url; // film : un seul « chapitre »

  for (const c of chapters) {
    if (episodeNumberOf(c.label, c.url) === episode) return c.url;
  }
  return null;
}

async function playersFrom(readingUrl: string, signal?: AbortSignal): Promise<Embed[]> {
  const html = await getText(readingUrl, { timeoutMs: 15000, signal });
  if (!html) return [];
  const out: Embed[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(PLAYER_RX)) {
    const url = m[2].replace(/\\\//g, '/');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, server: serverName(url) });
  }
  return out;
}

/** L'API Movix, keyee par tmdbId. `definitive` = reponse autoritaire, pas une panne. */
async function fromMovixApi(
  tmdbId: string,
  season: number,
  episode: number,
  signal?: AbortSignal,
): Promise<{ embeds: Embed[]; definitive: boolean }> {
  const cfg = siteEndpoints.get();
  const api = String(cfg.movixApi).replace(/\/+$/, '');
  const referer = String(cfg.movixReferer);

  const data = await getJson<{ success?: boolean; data?: { name?: string; link?: string }[] }>(
    `${api}/api/drama/tv/${tmdbId}?season=${season}&episode=${episode}`,
    {
      headers: { Referer: referer, Origin: referer.replace(/\/$/, ''), Accept: 'application/json' },
      timeoutMs: 12000,
      signal,
    },
  );

  if (!data) return { embeds: [], definitive: false };
  if (data.success === false || !Array.isArray(data.data)) return { embeds: [], definitive: true };

  const out: Embed[] = [];
  const seen = new Set<string>();
  for (const p of data.data) {
    const link = p?.link;
    if (!link || !/^https?:\/\//.test(link) || seen.has(link)) continue;
    seen.add(link);
    out.push({ url: link, server: serverName(link) });
  }
  return { embeds: out, definitive: true };
}

function extractorConfig(): ExtractorConfig {
  const mf = mediaflowConfig();
  return {
    useMediaFlow: Boolean(mf),
    mediaFlowUrl: mf?.url,
    mediaFlowPassword: mf?.password,
  };
}

/** Extrait les embeds jouables, un par hebergeur, en parallele. */
/**
 * Complete la resolution que l'extracteur n'a pas su lire.
 *
 * Les extracteurs annoncent souvent « HD » : certains ne sondent pas la playlist,
 * d'autres tombent sur un hebergeur qui ne publie rien. Le flux, lui, porte toujours
 * l'information — mesuree ici comme pour KissKH. Constate sur voembed, dont le master
 * annonce pourtant `RESOLUTION=1800x900` sans que l'extracteur le releve.
 *
 * On ne mesure QUE l'inconnu : une resolution deja lue par l'extracteur fait foi, et
 * la mesure coute une requete.
 */
async function completerQualites(candidats: Candidate[], ctx: SearchContext): Promise<Candidate[]> {
  return Promise.all(
    candidats.map(async (c) => {
      if (!isUnknownQuality(c.quality) || !c.directUrl) return c;
      const mesuree = await mesurerQualite(c.directUrl, {
        headers: c.headers,
        signal: ctx.deadline.signal,
        restantMs: ctx.restant(),
      });
      return mesuree ? { ...c, quality: mesuree } : c;
    }),
  );
}

async function extractAll(embeds: Embed[], language: string): Promise<Candidate[]> {
  const supported = embeds.filter((e) => {
    try {
      return detectExtractor(e.url) !== null;
    } catch {
      return false;
    }
  });
  if (supported.length === 0) return [];

  const seen = new Set<string>();
  const deduped = supported
    .filter((e) => {
      if (seen.has(e.server)) return false;
      seen.add(e.server);
      return true;
    })
    .slice(0, MAX_EXTRACTIONS);

  const cfg = extractorConfig();
  const results = await Promise.all(
    deduped.map(async (e) => {
      try {
        const r = await extractStream(e.url, cfg);
        if (!r?.url) return null;
        return { embed: e, stream: r };
      } catch {
        return null;
      }
    }),
  );

  return results
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map(({ embed, stream }) => ({
      sourceId: 'voirdrama',
      kind: 'direct' as const,
      title: `VoirDrama - ${embed.server}`,
      quality: stream.quality || 'HD',
      language,
      directUrl: stream.url,
      headers: stream.headers,
    }));
}

const ASIAN_LANGS = new Set(['ko', 'zh', 'cn', 'ja', 'th', 'tl', 'id', 'vi']);

async function searchVoirDrama(q: Query, ctx: SearchContext): Promise<Candidate[]> {
  const signal = ctx.deadline.signal;
  const key = `voirdrama:${q.type}:${q.tmdbId || normalizeTitle(q.titles[0] || '')}:${q.season || ''}:${q.episode || ''}`;

  return cached<Candidate[]>(
    key,
    TTL_MS,
    async () => {
      // 1) L'API, quand on a un tmdbId et qu'il s'agit d'une serie.
      if (q.type === 'series' && q.tmdbId && q.season && q.episode) {
        const { embeds, definitive } = await fromMovixApi(q.tmdbId, q.season, q.episode, signal);
        if (embeds.length > 0) {
          const streams = await completerQualites(await extractAll(embeds, 'VOSTFR'), ctx);
          if (streams.length > 0) return streams;
        }
        // Reponse autoritaire sur du non-asiatique : inutile de scraper derriere.
        if (definitive && !ASIAN_LANGS.has(q.originalLanguage || '')) return [];
      }

      // 2) Le scraping, pour les films, la VF, et les trous de l'API.
      const title = q.titles[0];
      if (!title || ctx.restant() < 2000) return [];

      const fiches = await searchSite(title, q.type === 'series' ? q.season : undefined, signal);
      const perFiche = await Promise.all(
        fiches.map(async (f) => {
          const reading = await findReadingPage(f.url, q.type === 'series' ? q.episode : undefined, signal);
          if (!reading) return [];
          const embeds = await playersFrom(reading, signal);
          return embeds.length > 0 ? extractAll(embeds, f.language) : [];
        }),
      );
      return completerQualites(perFiche.flat(), ctx);
    },
    { scope: 'voirdrama', shouldCache: (v) => v.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
}

export const voirdramaSource: Source = {
  id: 'voirdrama',
  label: 'VoirDrama',
  kind: 'direct',
  needsDebrid: false,
  search: searchVoirDrama,
};
