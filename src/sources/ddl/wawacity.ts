// Wawacity — deuxieme source DDL, redondance de Zone-Telechargement.
//
// Structure relevee sur wawacity.estate le 2026-08-13 (et non devinee) :
//
//   - Recherche : GET /?p=series&search=<titre>   (« series » au PLURIEL — la forme
//     au singulier renvoie silencieusement la page d'accueil, ce qui donne l'illusion
//     d'un site sans resultat.)
//   - Fiches    : /?p=serie&id=<n>-<slug>          (« serie » au SINGULIER, cette fois)
//   - Liens     : tous derriere le protecteur `dl-protect.link`
//
// LE CADEAU DE CE SITE : chaque lien protege porte un parametre `fn=` qui est le nom
// de fichier EN BASE64 —
//     fn=U3F1aWQgR2FtZS4uLg  ->  « Squid Game - Saison 1 Épisode 1 - [VF HD] »
// On lit donc la saison, l'episode, la langue et la qualite SANS ouvrir un seul lien.
// C'est ce qui rend cette source peu couteuse malgre son protecteur.
//
// Le protecteur lui-meme n'est pas resolu par nous : `dl-protect` est un redirecteur
// que les debrideurs savent traiter (cf. `resolveDdl` dans debrid/alldebrid.ts).

import { getText } from '../../core/http';
import { cached } from '../../core/cache';
import { makeEndpointConfig } from '../../core/endpoint-config';
import { matchesTitle } from '../../core/matching';
import { qualityOf, languageOf } from '../torrent/release';
import { hotesSupportes, hoteExploitable } from '../../debrid/hosts';
import type { Candidate, Query, SearchContext, Source } from '../types';

const TTL_MS = 60 * 60 * 1000;
const EMPTY_TTL_MS = 15 * 60 * 1000;
const MAX_FICHES = 4;
const MAX_LINKS = 4;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

const endpoints = makeEndpointConfig('wawacity-endpoints.json', 'WAWACITY_ENDPOINTS_CONFIG', {
  base: 'https://wawacity.estate',
});
export const reloadWawacityEndpoints = endpoints.reload;

const BASE = (): string => String(endpoints.get().base).replace(/\/+$/, '');

/** Signature d'un domaine parque : mieux vaut rendre zero que du contenu publicitaire. */
export function looksParked(html: string): boolean {
  return /sk-park\.php|"mode":"iframe"|domain (?:is )?for sale/i.test(html.slice(0, 4000));
}

/**
 * Franchit le portillon FingerprintJS, quand il est actif.
 *
 * Il ne s'agit pas d'un contournement d'anti-bot : la page intermediaire publie
 * elle-meme `redirect_link` et une valeur de repli `fp=-5` prevue pour les clients
 * sans JavaScript. Sur wawacity.estate le portillon est absent — mais il etait present
 * sur l'ancien domaine, et il peut revenir.
 */
export function gateTarget(html: string): string | null {
  const m = html.match(/redirect_link\s*=\s*['"]([^'"]+)['"]/);
  if (!m) return null;
  const base = m[1];
  return base.endsWith('&') || base.endsWith('?') ? `${base}fp=-5` : `${base}&fp=-5`;
}

async function fetchPage(url: string, signal?: AbortSignal): Promise<string | null> {
  const first = await getText(url, { timeoutMs: 20000, signal, maxBytes: MAX_HTML_BYTES });
  if (!first) return null;
  if (looksParked(first)) {
    console.log('[Wawacity] domaine parque — mettre a jour config/wawacity-endpoints.json');
    return null;
  }

  const target = gateTarget(first);
  if (!target) return first;

  const second = await getText(target, {
    timeoutMs: 20000,
    signal,
    maxBytes: MAX_HTML_BYTES,
    headers: { Referer: url },
  });
  return second && !looksParked(second) ? second : null;
}

/**
 * Liens de fiches d'une page de resultats : `?p=serie&id=12748-squid-game-saison1`.
 *
 * La page melange les deux ecritures de l'esperluette — `&id=` sur certains liens,
 * `&amp;id=` sur d'autres. On decode donc CHAQUE href avant de le tester, plutot que
 * de chercher une forme litterale qui n'en verrait que la moitie.
 */
export function parseSearchResults(html: string): string[] {
  const out = new Set<string>();
  let i = 0;
  while ((i = html.indexOf('href="', i)) !== -1) {
    const end = html.indexOf('"', i + 6);
    if (end === -1) break;
    const url = html.slice(i + 6, end).replace(/&amp;/g, '&');
    i = end + 1;
    if (/[?&]p=serie&id=\d+/.test(url)) out.add(url);
  }
  return [...out];
}

export interface WawaLink {
  url: string;
  /** Nom de fichier decode : « Squid Game - Saison 1 Épisode 1 - [VF HD] ». */
  filename: string;
  season: number | null;
  episode: number | null;
  /** Hebergeur annonce par la fiche : « 1fichier », « Uptobox », « Vidlox »... */
  hebergeur: string;
  sizeBytes?: number;
}

/**
 * Lecteurs de STREAMING, a distinguer des hebergeurs de telechargement.
 *
 * La fiche melange les deux sections derriere le MEME protecteur dl-protect : rien
 * dans l'URL ne les separe, seul le nom porte par la cellule voisine le fait.
 *
 * On liste ici ce qu'on ECARTE, et non ce qu'on garde. La liste de ce qu'on garde
 * n'est pas la notre a ecrire : c'est celle que publient AllDebrid et TorBox, et elle
 * depend des cles de chaque utilisateur (cf. debrid/hosts.ts). L'avoir devinee a la
 * main affichait des flux injouables ET en jetait de parfaitement valables.
 */
const LECTEURS_STREAMING = ['vidlox', 'dood', 'anonyme', 'vidmoly', 'uqload', 'voe'];

export function estLecteurStreaming(hebergeur: string): boolean {
  const h = hebergeur.toLowerCase().replace(/[\s._-]/g, '');
  return LECTEURS_STREAMING.some((x) => h.includes(x));
}

/** « 2 Go » / « 1.4 GB » -> octets. */
export function parseTaille(texte: string): number | undefined {
  const m = texte.trim().match(/^([\d.,]+)\s*(o|ko|mo|go|to|b|kb|mb|gb|tb)$/i);
  if (!m) return undefined;
  const valeur = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(valeur)) return undefined;
  const unite = m[2].toLowerCase();
  const facteurs: Record<string, number> = {
    o: 1, b: 1,
    ko: 1024, kb: 1024,
    mo: 1024 ** 2, mb: 1024 ** 2,
    go: 1024 ** 3, gb: 1024 ** 3,
    to: 1024 ** 4, tb: 1024 ** 4,
  };
  const f = facteurs[unite];
  return f ? Math.round(valeur * f) : undefined;
}

/** Texte brut d'une cellule, balises retirees. */
function texteCellule(bloc: string, largeur: string): string {
  const cle = `width="${largeur}"`;
  const at = bloc.indexOf(cle);
  if (at === -1) return '';
  const debut = bloc.indexOf('>', at);
  const fin = bloc.indexOf('</td>', debut);
  if (debut === -1 || fin === -1) return '';
  return bloc
    .slice(debut + 1, fin)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Decode le `fn=` base64url d'un lien protege. */
export function decodeFn(url: string): string | null {
  const m = url.match(/[?&]fn=([A-Za-z0-9+/=_-]+)/);
  if (!m) return null;
  try {
    const normalized = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64').toString('utf-8');
    // Les liens de service portent une charge technique (« series|12748|1 ») plutot
    // qu'un nom de fichier : on les ecarte.
    return decoded.includes('|') ? null : decoded;
  } catch {
    return null;
  }
}

/** Saison et episode d'un nom de fichier francais : « Saison 1 Épisode 3 ». */
export function seasonEpisodeFromFilename(filename: string): { season: number | null; episode: number | null } {
  const normalized = filename.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const s = normalized.match(/saison\s*0*(\d{1,2})/);
  const e = normalized.match(/episode\s*0*(\d{1,3})/);
  return { season: s ? Number(s[1]) : null, episode: e ? Number(e[1]) : null };
}

/**
 * Liens d'une fiche, lus ligne par ligne.
 *
 * On decoupe sur `<tr class="link-row">` plutot que de balayer les URL isolement :
 * c'est la LIGNE qui porte le nom de l'hebergeur et la taille, dans des cellules
 * voisines. Sans ce decoupage on ne saurait pas distinguer un lien 1fichier d'un
 * lecteur Vidlox — les deux ont exactement la meme forme d'URL protegee.
 */
export function parseFicheLinks(html: string): WawaLink[] {
  const out: WawaLink[] = [];
  const seen = new Set<string>();

  // Les lignes commentees (`<!--`) sont des offres publicitaires desactivees par le
  // site : les inclure ajouterait des faux liens.
  const sansCommentaires = html.replace(/<!--[\s\S]*?-->/g, '');

  let i = 0;
  while ((i = sansCommentaires.indexOf('class="link-row"', i)) !== -1) {
    const debut = sansCommentaires.lastIndexOf('<tr', i);
    const fin = sansCommentaires.indexOf('</tr>', i);
    if (debut === -1 || fin === -1) break;
    const bloc = sansCommentaires.slice(debut, fin);
    i = fin + 5;

    const at = bloc.indexOf('dl-protect.link/');
    if (at === -1) continue;
    const q1 = bloc.lastIndexOf('"', at);
    const q2 = bloc.indexOf('"', at);
    if (q1 === -1 || q2 === -1) continue;

    const url = bloc.slice(q1 + 1, q2).replace(/&amp;/g, '&');
    if (seen.has(url)) continue;
    seen.add(url);

    const filename = decodeFn(url);
    if (!filename) continue;

    const hebergeur = texteCellule(bloc, '120px');
    const { season, episode } = seasonEpisodeFromFilename(filename);
    out.push({
      url,
      filename,
      season,
      episode,
      hebergeur: hebergeur || 'inconnu',
      sizeBytes: parseTaille(texteCellule(bloc, '80px')),
    });
  }
  return out;
}

function absolute(u: string): string {
  if (/^https?:\/\//.test(u)) return u;
  return `${BASE()}/${u.replace(/^[./]+/, '')}`;
}

async function searchWawacity(q: Query, ctx: SearchContext): Promise<Candidate[]> {
  const title = q.titles[0];
  if (!title) return [];

  // Les hebergeurs que CET utilisateur peut reellement debloquer.
  const supportes = await hotesSupportes(ctx.config);
  const section = q.type === 'series' ? 'series' : 'films';
  const searchUrl = `${BASE()}/?p=${section}&search=${encodeURIComponent(title)}`;

  const fiches = await cached<string[]>(
    `wawa:search:${section}:${title.toLowerCase()}`,
    TTL_MS,
    async () => {
      const html = await fetchPage(searchUrl, ctx.deadline.signal);
      return html ? parseSearchResults(html) : [];
    },
    { scope: 'wawacity', shouldCache: (v) => v.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );

  // Le slug de la fiche porte le titre ET la saison : on filtre AVANT d'ouvrir la
  // page, ce qui evite d'en telecharger quatre pour rien.
  const pertinentes = fiches.filter((u) => {
    const slug = (u.split('id=')[1] || '').replace(/^\d+-/, '').replace(/-/g, ' ');
    if (!matchesTitle(slug, q.titles, { threshold: 0.6 })) return false;
    if (q.type !== 'series' || q.season === undefined) return true;
    const s = slug.match(/saison\s*0*(\d{1,2})/i);
    return !s || Number(s[1]) === q.season;
  });

  const out: Candidate[] = [];
  for (const fiche of pertinentes.slice(0, MAX_FICHES)) {
    if (ctx.deadline.remainingMs() < 2500) break;

    const html = await fetchPage(absolute(fiche), ctx.deadline.signal);
    if (!html) continue;

    const links = parseFicheLinks(html).filter((l) => {
      // Ecarte les lecteurs de streaming : seuls les hebergeurs de telechargement
      // que le debrideur sait debloquer nous interessent.
      if (estLecteurStreaming(l.hebergeur)) return false;
      if (!hoteExploitable(l.hebergeur, supportes)) return false;
      if (q.type === 'movie' || q.episode === undefined) return true;
      // Un lien sans numero d'episode sur une fiche de serie est ambigu : on l'ecarte
      // plutot que de risquer de servir le mauvais episode.
      if (l.episode === null) return false;
      if (l.season !== null && q.season !== undefined && l.season !== q.season) return false;
      return l.episode === q.episode;
    });

    // Un seul lien par hebergeur : au-dela c'est de la redondance que l'utilisateur
    // ne peut pas distinguer (le protecteur masque la destination).
    const parHebergeur = new Map<string, (typeof links)[number]>();
    for (const l of links) {
      const cle = l.hebergeur.toLowerCase();
      if (!parHebergeur.has(cle)) parHebergeur.set(cle, l);
    }

    for (const link of [...parHebergeur.values()].slice(0, MAX_LINKS)) {
      out.push({
        sourceId: 'wawacity',
        kind: 'ddl',
        title: `${link.filename} — ${link.hebergeur}`,
        quality: qualityOf(link.filename),
        language: languageOf(link.filename),
        sizeBytes: link.sizeBytes,
        ddlUrl: link.url,
        ddlHost: link.hebergeur,
        fileHint: link.filename,
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
