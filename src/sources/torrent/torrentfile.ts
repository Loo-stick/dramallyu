// Recuperation du hash quand le tracker ne le publie pas.
//
// Certains trackers prives ne rendent qu'un lien vers le .torrent. Sans hash, on ne
// peut ni interroger le cache du debrideur ni lui demander la resolution : le resultat
// est inutilisable. Il faut donc telecharger le fichier et calculer le hash.
//
// C'est l'operation la plus chere de tout le fan-out : une requete HTTP PAR resultat.
// D'ou les trois garde-fous ci-dessous, qui ne sont pas negociables.

import { cached } from '../../core/cache';
import { infoHashDepuisTorrent } from '../../core/bencode';
import { BROWSER_HEADERS } from '../../core/http';

/**
 * Le hash d'un torrent ne change JAMAIS. Un mois de cache n'est donc pas une
 * approximation : c'est la duree de vie de la verite qu'on memorise.
 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_ECHEC_MS = 6 * 60 * 60 * 1000;

/** Un .torrent depasse rarement 100 Ko ; au-dela c'est qu'on ne telecharge pas ca. */
const TAILLE_MAX = 2 * 1024 * 1024;

export interface OptionsTorrent {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * info_hash d'un .torrent distant, ou `null`.
 *
 * `cleCache` doit identifier le torrent SANS porter de secret : les liens de
 * telechargement des trackers prives contiennent la cle d'API de l'utilisateur, et
 * elle n'a rien a faire dans un cache partage ecrit sur disque.
 */
export async function hashDepuisLien(
  url: string,
  cleCache: string,
  opts: OptionsTorrent = {},
): Promise<string | null> {
  return cached<string | null>(
    `torrenthash:${cleCache}`,
    TTL_MS,
    async () => {
      try {
        const res = await fetch(url, {
          headers: { ...BROWSER_HEADERS, ...opts.headers },
          signal: opts.signal,
        });
        if (!res.ok) return null;

        const annonce = Number(res.headers.get('content-length') || 0);
        if (annonce > TAILLE_MAX) return null;

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > TAILLE_MAX) return null;
        return infoHashDepuisTorrent(buf);
      } catch {
        return null;
      }
    },
    { scope: 'torrenthash', shouldCache: (v) => v !== null, negativeTtlMs: TTL_ECHEC_MS },
  );
}

/**
 * Complete les hashes manquants, en parallele et sous plafond.
 *
 * Le plafond est le garde-fou principal : sans lui, une recherche large declencherait
 * une centaine de telechargements et ferait exploser le budget du fan-out. On trie
 * donc par sources decroissantes AVANT de couper — si on ne peut en resoudre que
 * quelques-uns, autant que ce soient ceux qui ont le plus de chances d'etre en cache
 * chez un debrideur.
 */
export async function completerHashes<T>(
  items: T[],
  plafond: number,
  lienDe: (item: T) => { url: string; cle: string } | null,
  sourcesDe: (item: T) => number,
  opts: OptionsTorrent = {},
): Promise<Map<T, string>> {
  const candidats = [...items].sort((a, b) => sourcesDe(b) - sourcesDe(a)).slice(0, plafond);

  const resolus = await Promise.all(
    candidats.map(async (item) => {
      const lien = lienDe(item);
      if (!lien) return null;
      const hash = await hashDepuisLien(lien.url, lien.cle, opts);
      return hash ? ([item, hash] as const) : null;
    }),
  );

  return new Map(resolus.filter((r): r is [T, string] => r !== null));
}
