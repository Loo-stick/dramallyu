// DigitalCore — tracker prive, API REST par TEXTE.
//
// Deux differences importantes avec les autres sources torrent :
//
//  1. La recherche se fait par TITRE, pas par identifiant. On doit donc filtrer les
//     resultats sur le titre comme pour un Torznab, sous peine de ramener n'importe
//     quoi qui partage un mot.
//  2. La recherche ne rend JAMAIS de hash. Chaque resultat retenu coute un
//     telechargement de .torrent pour le calculer — l'operation la plus chere du
//     fan-out. D'ou un plafond strict, un tri par sources avant de couper, et un cache
//     d'un mois sur chaque hash obtenu.

import { getSettings } from '../../core/settings';
import { cached } from '../../core/cache';
import { getJson } from '../../core/http';
import { matchesTitle } from '../../core/matching';
import { parseRelease, matchesEpisode } from './release';
import { episodeHint } from '../../debrid/types';
import { completerHashes } from './torrentfile';
import type { Candidate, Query, SearchContext, Source } from '../types';

const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;

/**
 * Plafond de telechargements de .torrent par recherche.
 *
 * StreamFusion en autorise 25. On en prend 8 : son architecture n'a pas de budget de
 * fan-out, la notre coupe a quelques secondes et doit laisser respirer six autres
 * sources. Les resultats sont tries par sources decroissantes avant la coupe, donc on
 * resout d'abord ceux qui ont le plus de chances d'etre en cache chez un debrideur.
 */
const MAX_TELECHARGEMENTS = 8;

/** Categories du tracker. Sert a ne pas proposer un film pour une serie, et l'inverse. */
const CATEGORIES_FILM = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
const CATEGORIES_SERIE = new Set([9, 10, 11, 12]);

interface ItemDc {
  id?: number | string;
  name?: string;
  size?: number | string;
  seeders?: number | string;
  category?: number;
  imdbid2?: string;
}

function nombre(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Requetes a lancer, de la plus precise a la plus large.
 *
 * La plus large sert les PACKS : un drama entier est souvent publie en une seule
 * entree « S01 », que la recherche par episode ne trouverait jamais.
 */
function requetesPour(q: Query): string[] {
  // Deux formes au plus : le titre de tete, puis le titre international s'il differe.
  // Un drama asiatique est publie sous l'un ou sous l'autre, rarement sous les deux.
  const formes = [q.titles[0], q.titreAnglais].filter(
    (t, i, a): t is string => Boolean(t) && a.indexOf(t) === i,
  );
  if (formes.length === 0) return [];

  const out: string[] = [];
  for (const titre of formes) {
    if (q.type !== 'series' || q.season === undefined) {
      if (q.year) out.push(`${titre} ${q.year}`);
      out.push(titre);
      continue;
    }
    const saison = `S${String(q.season).padStart(2, '0')}`;
    if (q.episode !== undefined) out.push(`${titre} ${saison}E${String(q.episode).padStart(2, '0')}`);
    out.push(`${titre} ${saison}`);
  }
  return out;
}

async function chercher(
  base: string,
  apiKey: string,
  requete: string,
  signal?: AbortSignal,
): Promise<ItemDc[] | null> {
  // La cle N'ENTRE PAS dans la cle de cache : le resultat est partageable entre
  // utilisateurs, le secret non. En contrepartie, `null` — l'appel a echoue — n'est
  // JAMAIS memorise : une cle refusee ne doit pas faire passer le tracker pour vide
  // aux yeux des autres utilisateurs.
  return cached<ItemDc[] | null>(
    `digitalcore:${requete}`,
    TTL_MS,
    async () => {
      const qs = new URLSearchParams({ searchText: requete, apikey: apiKey });
      const data = await getJson<unknown[]>(`${base}/api/v1/torrents?${qs}`, {
        timeoutMs: 12000,
        signal,
        retries: 1,
        headers: { Accept: 'application/json' },
      });
      if (data === null) return null;
      return Array.isArray(data) ? (data.filter((x) => x && typeof x === 'object') as ItemDc[]) : [];
    },
    {
      scope: 'digitalcore',
      echec: (v) => v === null,
      shouldCache: (v) => v !== null && v.length > 0,
      negativeTtlMs: TTL_VIDE_MS,
    },
  );
}

/** La categorie annoncee contredit-elle le type demande ? */
function mauvaiseCategorie(item: ItemDc, type: Query['type']): boolean {
  if (item.category === undefined) return false; // inconnue : on ne tranche pas
  return type === 'movie' ? CATEGORIES_SERIE.has(item.category) : CATEGORIES_FILM.has(item.category);
}

export const digitalcoreSource: Source = {
  id: 'digitalcore',
  label: 'DigitalCore',
  kind: 'torrent',
  needsDebrid: true,
  requiredUserKey: 'dcore',

  async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
    const reglages = getSettings().digitalcore;
    const apiKey = ctx.config.dcore;
    if (!reglages?.enabled || !apiKey) return [];

    const base = reglages.url.replace(/\/+$/, '');
    const hint = episodeHint(q.season, q.episode);

    const vus = new Set<string>();
    const retenus: ItemDc[] = [];

    // On distingue « le tracker n'a rien » de « le tracker ne repond pas » : la
    // seconde doit remonter comme un echec, pas comme une liste vide.
    let appels = 0;
    let echecs = 0;

    for (const requete of requetesPour(q)) {
      if (ctx.deadline.remainingMs() < 2500) break;
      appels++;
      const lot = await chercher(base, apiKey, requete, ctx.deadline.signal);
      if (lot === null) {
        echecs++;
        continue;
      }
      for (const item of lot) {
        const id = String(item.id ?? '');
        if (!id || vus.has(id) || !item.name) continue;
        vus.add(id);

        // L'identifiant IMDb, quand le tracker le porte, est une PREUVE : s'il
        // contredit la demande, aucune ressemblance de titre ne peut le racheter.
        if (q.imdbId && item.imdbid2 && item.imdbid2 !== q.imdbId) continue;
        if (mauvaiseCategorie(item, q.type)) continue;

        // Recherche par texte : sans ce filtre, « Signal » ramene tout ce qui contient
        // ce mot.
        if (!matchesTitle(item.name, q.titles, { year: q.year, threshold: 0.6 })) continue;
        if (!matchesEpisode(parseRelease(item.name), q.season, q.episode, q.episodesParSaison)) continue;

        retenus.push(item);
      }
    }

    // Aucun appel n'a abouti : signaler l'echec plutot que de rendre une liste vide,
    // qui se lirait comme « ce tracker n'a rien pour vous ».
    if (appels > 0 && echecs === appels) {
      throw new Error('DigitalCore : aucune reponse exploitable (cle refusee ou tracker injoignable)');
    }

    if (retenus.length === 0 || ctx.deadline.remainingMs() < 3000) return [];

    const hashes = await completerHashes(
      retenus,
      MAX_TELECHARGEMENTS,
      (it) => ({ url: `${base}/api/v1/torrents/download/${it.id}?apikey=${apiKey}`, cle: `digitalcore:${it.id}` }),
      (it) => Number(it.seeders ?? 0),
      { signal: ctx.deadline.signal },
    );

    const out: Candidate[] = [];
    for (const [item, infoHash] of hashes) {
      const parsed = parseRelease(item.name!);
      out.push({
        sourceId: 'digitalcore',
        kind: 'torrent',
        title: item.name!,
        quality: parsed.quality,
        language: parsed.language,
        sizeBytes: nombre(item.size),
        seeders: nombre(item.seeders) ?? 0,
        infoHash,
        // Tracker prive : sans le .torrent, le debrideur n'a qu'un hash sans annonceur.
        torrentUrl: `${base}/api/v1/torrents/download/${item.id}?apikey=${apiKey}`,
        fileHint: parsed.isPack ? hint : undefined,
      });
    }
    return out;
  },
};
