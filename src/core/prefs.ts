// Preferences utilisateur : normalisation, filtrage, tri.
//
// LEÇON REPRISE DE LOOSTREAM, et elle vaut d'etre redite : la QUALITE ne doit PAS
// servir de couperet. Un seuil « au moins 720p » parait raisonnable jusqu'au jour ou
// les sources se mettent a annoncer leur vraie resolution — et la, il ampute des flux
// parfaitement valides (une VF en 480p vaut mieux que rien pour qui cherche une VF).
// Ici la qualite ne sert qu'au TRI ; l'exclusion existe mais elle est OPT-IN et vide
// par defaut.

export const QUALITY_SCORES: Record<string, number> = {
  '4K': 4,
  '1080p': 3,
  '720p': 2,
  '576p': 1.5,
  '480p': 1,
  '360p': 0.6,
  HD: 2,
};

export function normalizeLanguage(lang: string): string {
  const upper = (lang || '').toUpperCase();
  if (upper.includes('MULTI')) return 'MULTI';
  if (upper.includes('VOSTFR') || upper.includes('VOST')) return 'VOSTFR';
  if (upper.includes('TRUEFRENCH') || upper === 'VF' || upper.includes('FRENCH') || upper === 'FRANCAIS') {
    return 'VF';
  }
  if (upper.includes('VF')) return 'VF';
  return 'VO';
}

export function normalizeQuality(quality: string): string {
  const upper = (quality || '').toUpperCase();
  if (upper.includes('4K') || upper.includes('2160') || upper.includes('UHD')) return '4K';
  if (upper.includes('1080')) return '1080p';
  if (upper.includes('720')) return '720p';
  if (upper.includes('576')) return '576p';
  if (upper.includes('480') || upper === 'SD') return '480p';
  if (upper.includes('360')) return '360p';
  if (upper.includes('HD') || upper.includes('FULL')) return '1080p';
  return 'HD';
}

/**
 * Resolution NON MESUREE : etiquette « HD » generique ou vide. Traitee a part de
 * l'exclusion par resolution — on ne peut pas honnetement affirmer que c'est du
 * 1080p, donc exclure « 1080p » ne doit pas l'amputer. L'utilisateur l'exclut
 * explicitement avec le jeton « unknown ».
 */
export function isUnknownQuality(quality: string): boolean {
  const q = (quality || '').trim();
  return !q || /^(hd|fhd|full\s?hd)$/i.test(q);
}

export interface RankableStream {
  quality: string;
  language: string;
  seeders?: number;
  sizeBytes?: number;
}

export function passesPreferences(s: RankableStream, excludeQualities: string[]): boolean {
  if (excludeQualities.length === 0) return true;
  if (isUnknownQuality(s.quality)) return !excludeQualities.includes('unknown');
  return !excludeQualities.includes(normalizeQuality(s.quality));
}

export type SortBy = 'language' | 'quality';

/**
 * Ordre de preference des langues pour un addon FR de dramas.
 *
 * VOSTFR devant VF, volontairement : sur du drama asiatique, la VF est rare, souvent
 * tardive, et le public de ce genre la boude largement. Un utilisateur qui prefere la
 * VF le dit dans sa config.
 */
export const DEFAULT_LANG_ORDER = ['VOSTFR', 'VF', 'MULTI', 'VO'];

function langRank(lang: string, order: string[]): number {
  const i = order.indexOf(normalizeLanguage(lang));
  return i === -1 ? 100 : i;
}

export interface SortOptions {
  langOrder: string[];
  sortBy: SortBy;
}

export function compareStreams(a: RankableStream, b: RankableStream, opts: SortOptions): number {
  const langCmp = langRank(a.language, opts.langOrder) - langRank(b.language, opts.langOrder);
  const qa = QUALITY_SCORES[normalizeQuality(a.quality)] ?? 2;
  const qb = QUALITY_SCORES[normalizeQuality(b.quality)] ?? 2;
  const qualityCmp = qb - qa;
  // A langue et qualite egales, les seeders departagent : c'est le seul signal
  // honnete de « ce flux va effectivement demarrer ».
  const seedCmp = (b.seeders ?? 0) - (a.seeders ?? 0);

  return opts.sortBy === 'quality'
    ? qualityCmp || langCmp || seedCmp
    : langCmp || qualityCmp || seedCmp;
}

/** Langue prefere de l'utilisateur, deduite de son ordre de sous-titres. */
export function langOrderFromSubs(subLangs: string[]): string[] {
  // Quelqu'un qui met le francais en tete de ses sous-titres veut du VOSTFR/VF avant
  // le reste. Quelqu'un qui met l'anglais en tete accepte la VO.
  if (subLangs[0] === 'fre') return DEFAULT_LANG_ORDER;
  return ['VO', 'MULTI', 'VOSTFR', 'VF'];
}
