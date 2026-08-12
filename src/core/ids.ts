// Identifiants Stremio -> identite canonique.
//
// L'addon doit repondre a TROIS provenances, sinon il devient un silo :
//   tt1399964:1:3   depuis Cinemeta ou AIOStreams (le cas majoritaire)
//   tmdb:1396:1:3   depuis un catalogue TMDB tiers
//   kkh:3749:1:3    depuis notre propre catalogue, pour les dramas absents d'IMDb
//
// Stremio decoupe sur ":", donc le prefixe fait partie du decoupage : "kkh:3749:1:3"
// donne quatre segments, pas trois. C'est la source d'erreur classique.

export type IdKind = 'imdb' | 'tmdb' | 'kkh';

export interface ParsedId {
  kind: IdKind;
  /** Identifiant nu, sans prefixe : "tt1399964", "1396", "3749". */
  value: string;
  season?: number;
  episode?: number;
}

function toPositiveInt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  if (!/^\d{1,4}$/.test(s)) return undefined;
  const n = Number(s);
  return n > 0 ? n : undefined;
}

/**
 * Decode un id Stremio. Renvoie null si l'id n'est pas exploitable — l'appelant
 * doit alors repondre une liste vide, jamais une erreur : un id inconnu est un cas
 * normal (l'utilisateur navigue dans un catalogue qu'on ne couvre pas).
 */
export function parseStremioId(raw: string): ParsedId | null {
  if (!raw) return null;
  const id = decodeURIComponent(raw).trim();
  const parts = id.split(':');
  const head = parts[0];
  if (!head) return null;

  if (/^tt\d{5,10}$/i.test(head)) {
    return {
      kind: 'imdb',
      value: head.toLowerCase(),
      season: toPositiveInt(parts[1]),
      episode: toPositiveInt(parts[2]),
    };
  }

  if (head === 'tmdb' || head === 'kkh') {
    const value = parts[1];
    if (!value || !/^\d{1,9}$/.test(value)) return null;
    return {
      kind: head === 'tmdb' ? 'tmdb' : 'kkh',
      value,
      season: toPositiveInt(parts[2]),
      episode: toPositiveInt(parts[3]),
    };
  }

  return null;
}

/** Reconstruit un id Stremio a partir de ses composants. */
export function formatStremioId(parsed: ParsedId): string {
  const prefix = parsed.kind === 'imdb' ? parsed.value : `${parsed.kind}:${parsed.value}`;
  if (parsed.season && parsed.episode) return `${prefix}:${parsed.season}:${parsed.episode}`;
  return prefix;
}

/** Cle stable pour le cache et les mappings, independante de la saison/episode. */
export function workKey(parsed: ParsedId): string {
  return `${parsed.kind}:${parsed.value}`;
}
