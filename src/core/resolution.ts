// Mesure de resolution, pour les flux directs qui ne l'annoncent pas.
//
// Trois cas, du moins cher au plus cher :
//
//  1. Playlist HLS MAITRE — elle liste ses variantes avec `RESOLUTION=WxH`. Gratuit.
//  2. Playlist HLS de SEGMENTS — aucune variante, donc rien d'annonce : on lit le SPS
//     du premier segment (128 Ko en requete Range). C'est le cas de KissKH.
//  3. Fichier MP4 — on lit l'en-tete d'echantillon video dans les premiers 256 Ko.
//
// Ce module ne decide de rien : il rend une etiquette ou `null`. L'appelant garde son
// etiquette generique quand la mesure echoue — on n'invente jamais une resolution,
// une valeur fausse faisant trier sur du vide, ce qui est pire que pas de valeur.

import { getText, BROWSER_HEADERS } from './http';
import { cached } from './cache';
import { dimensionsDepuisTs, dimensionsDepuisMp4, qualiteDepuis, type Dimensions } from './h264';

/** La resolution d'un flux ne change jamais : on la garde longtemps. */
const TTL_MS = 24 * 60 * 60 * 1000;
const TTL_ECHEC_MS = 30 * 60 * 1000;
const FENETRE_OCTETS = 128 * 1024;

export interface OptionsMesure {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Millisecondes encore disponibles dans le fan-out. */
  restantMs: number;
}

async function lireDebut(url: string, opts: OptionsMesure, octets: number): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, ...opts.headers, Range: `bytes=0-${octets - 1}` },
      signal: opts.signal,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Cle de cache STABLE : les URL de flux portent des jetons signes qui changent a
 * chaque resolution. Sans ce nettoyage, chaque requete creerait une entree neuve et
 * retelechargerait la fenetre — le cache ne servirait a rien.
 */
function cle(url: string): string {
  return url.split('?')[0];
}

async function mesurerHls(url: string, opts: OptionsMesure): Promise<Dimensions | null> {
  const body = await getText(url, {
    timeoutMs: 4000,
    signal: opts.signal,
    retries: 0,
    maxBytes: 256 * 1024,
    headers: opts.headers,
  });
  if (!body) return null;

  // Cas 1 : playlist maitre. La meilleure variante fait foi — c'est celle qu'un
  // lecteur choisira sur une connexion correcte.
  let meilleure: Dimensions | null = null;
  for (const m of body.matchAll(/RESOLUTION=(\d{2,5})x(\d{2,5})/g)) {
    const d = { width: Number(m[1]), height: Number(m[2]) };
    if (!meilleure || d.height > meilleure.height) meilleure = d;
  }
  if (meilleure) return meilleure;

  // Cas 2 : playlist de segments. On lit le flux lui-meme.
  const segment = body.split('\n').find((l) => l.startsWith('http'))?.trim();
  if (!segment || opts.restantMs < 2500) return null;
  const buf = await lireDebut(segment, opts, FENETRE_OCTETS);
  return buf ? dimensionsDepuisTs(buf) : null;
}

/**
 * Etiquette de qualite mesuree pour un flux direct, ou `null` si on n'a pas su lire.
 *
 * Le resultat est mis en cache 24 h : la resolution d'un episode ne bouge pas. Les
 * echecs le sont 30 min, pour ne pas rejouer une lecture qui vient d'echouer a chaque
 * requete sans pour autant la condamner definitivement.
 */
export async function mesurerQualite(url: string, opts: OptionsMesure): Promise<string | null> {
  if (opts.restantMs < 3000) return null;

  const dims = await cached<Dimensions | null>(
    `dims:${cle(url)}`,
    TTL_MS,
    async () => {
      if (/\.m3u8(\?|$)/i.test(url) || /\/hls\d*\//i.test(url)) return mesurerHls(url, opts);
      const buf = await lireDebut(url, opts, 256 * 1024);
      return buf ? dimensionsDepuisMp4(buf) : null;
    },
    { scope: 'resolution', shouldCache: (v) => v !== null, negativeTtlMs: TTL_ECHEC_MS },
  );

  return dims ? qualiteDepuis(dims) : null;
}
