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
import { hotesSupportes, hoteExploitable } from '../../debrid/hosts';
import { estMort } from '../../debrid/deadlinks';
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

/**
 * Noms d'hebergeurs PLAUSIBLES, servant seulement a reconnaitre une image de section
 * et une URL dans la page du protecteur.
 *
 * Ce n'est PAS une liste de ce qui est debridable — cette liste-la n'est pas la notre
 * a ecrire. Celle que j'avais mise ici retenait Uptobox, que ni AllDebrid ni TorBox ne
 * prennent, et Nitroflare, inactif chez les deux : des flux affiches pour rien. Le
 * verdict vient desormais des debrideurs eux-memes (debrid/hosts.ts), pour les cles de
 * chaque utilisateur.
 */
const NOMS_HEBERGEURS = [
  '1fichier', 'uptobox', 'rapidgator', 'turbobit', 'nitroflare', 'uploady',
  'dailyuploads', 'darkibox', '1dl', 'fikper', 'katfile', 'mixdrop',
];

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
        if (NOMS_HEBERGEURS.some((h) => name.includes(h))) currentHost = name;
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

/**
 * Liens d'une fiche, MIS EN CACHE.
 *
 * La page etait re-telechargee a chaque requete : seules la recherche et les
 * protecteurs etaient memorises. Mesure en production, avec toutes les autres sources
 * en cache chaud (1 a 7 ms), Zone-Telechargement pesait a lui seul 6,5 s sur une
 * reponse de 6,5 s.
 *
 * On memorise les liens ANALYSES, pas le HTML : une fiche pese jusqu'a 3 Mo, la liste
 * qu'on en tire quelques centaines d'octets. Garder le HTML gonflerait le cache pour
 * rien — on ne le relit jamais.
 */
async function liensDeFiche(fiche: string, signal?: AbortSignal): Promise<ZtLink[]> {
  return cached<ZtLink[]>(
    `zt:fiche:${fiche}`,
    TTL_MS,
    async () => {
      const html = await getText(fiche, { timeoutMs: 20000, signal, maxBytes: MAX_HTML_BYTES });
      return html ? parseFicheLinks(html) : [];
    },
    { scope: 'zt', shouldCache: (v) => v.length > 0, negativeTtlMs: EMPTY_TTL_MS },
  );
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
        if (NOMS_HEBERGEURS.some((h) => candidate.toLowerCase().includes(h))) return candidate;
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

  // Ce que les debrideurs de CET utilisateur savent reellement debloquer.
  const supportes = await hotesSupportes(ctx.config);

  const fiches = await searchFiches(title, ctx.deadline.signal);

  // Les fiches retenues sont traitees EN PARALLELE, et les liens d'une fiche aussi.
  // C'etait entierement sequentiel : jusqu'a quinze allers-retours HTTP a la file, ce
  // qui faisait de cette source le goulot de tout le fan-out. Les bornes MAX_FICHES et
  // MAX_LINKS gardent le parallelisme modeste — au plus douze requetes de front, pas
  // de quoi inquieter ni le site ni la memoire de l'hote.
  const retenues = fiches
    .slice(0, MAX_FICHES)
    .map((fiche) => {
      // Le titre de la fiche est dans son slug : on filtre AVANT d'ouvrir la page, ce
      // qui evite d'en telecharger trois pour rien.
      const slug = fiche.split('/').pop() || '';
      const readable = slug.replace(/^\d+-telecharger-/, '').replace(/\.html$/, '').replace(/-/g, ' ');
      return { fiche, readable };
    })
    .filter(({ readable }) => matchesTitle(readable, q.titles, { threshold: 0.6 }));

  if (retenues.length === 0 || ctx.deadline.remainingMs() < 2500) return [];

  const parFiche = await Promise.all(
    retenues.map(async ({ fiche, readable }) => {
      const liens = await liensDeFiche(fiche, ctx.deadline.signal);
      const parsed = parseRelease(readable);

      const utiles = liens
        .filter((l) => {
          if (q.type === 'movie' || q.episode === undefined) return true;
          // Un lien sans numero d'episode sur une fiche de serie est ambigu : on
          // l'ecarte plutot que de risquer de servir le mauvais episode.
          return l.episode === q.episode;
        })
        // Deja constate mort au moment d'un Play precedent : inutile de resoudre le
        // protecteur, et surtout inutile de le reproposer.
        .filter((l) => !estMort(l.protectedUrl))
        .slice(0, MAX_LINKS);

      if (utiles.length === 0 || ctx.deadline.remainingMs() < 2000) return [];

      const resolus = await Promise.all(
        utiles.map(async (link) => {
          const real = await resolveProtected(link.protectedUrl, ctx.deadline.signal);
          if (!real) return null;

          // Le protecteur resolu, on connait le VRAI hebergeur : on ecarte ici ce
          // qu'aucun debrideur de l'utilisateur ne prend, plutot que de lui proposer
          // un flux dont le clic finira en erreur.
          const hote = hostOf(real);
          if (!hoteExploitable(hote, supportes)) return null;

          return {
            sourceId: 'zonetelechargement',
            kind: 'ddl',
            title: readable.trim(),
            quality: parsed.quality,
            language: parsed.language,
            ddlUrl: real,
            ddlHost: hote,
          } as Candidate;
        }),
      );
      return resolus.filter((c): c is Candidate => c !== null);
    }),
  );

  const out = parFiche.flat();
  return out;
}

export const zoneTelechargementSource: Source = {
  id: 'zonetelechargement',
  label: 'Zone-Telechargement',
  kind: 'ddl',
  needsDebrid: true,
  search: searchZt,
};
