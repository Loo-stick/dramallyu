// Configuration PAR UTILISATEUR, transportee en base64 dans le chemin d'installation.
//
// Regle du projet : l'operateur ne fournit AUCUNE cle. Tout ce qui donne acces a un
// service tiers (debrid, trackers, TMDB) vit ici, dans la config de chaque personne.
//
// AVERTISSEMENT ASSUME : ce blob est ENCODE, pas CHIFFRE. Quiconque voit l'URL
// d'installation voit les cles. C'est le modele de LooStream et d'AIOStreams v1 ;
// il est acceptable en HTTPS mais doit etre ecrit noir sur blanc sur /configure.

export type SortBy = 'language' | 'quality';

export interface UserConfig {
  /** Cle API AllDebrid. */
  ad?: string;
  /** Cle API TorBox. */
  tb?: string;
  /** Cle Torznab C411. */
  c411?: string;
  /** Cle Torznab Tr4ker. */
  tr4ker?: string;
  /** Cle Torznab du relais Ygg. */
  ygg?: string;
  /** Cle TMDB (optionnelle : enrichit en FR, sinon on sert Cinemeta + KissKH). */
  tmdb?: string;
  /** Langues de sous-titres, ISO 639-2, par ordre de preference. */
  subLangs: string[];
  /** Qualites exclues (opt-in). Vide = aucune exclusion. */
  excludeQualities: string[];
  /** Sources activees par leur id. Vide = toutes celles que l'operateur autorise. */
  sources: string[];
  /** Ce qui prime au tri : la langue ou la qualite. */
  sortBy: SortBy;
  /** Nombre maximum de flux renvoyes. */
  maxResults: number;
}

export const DEFAULT_CONFIG: UserConfig = {
  subLangs: ['fre', 'eng'],
  excludeQualities: [],
  sources: [],
  sortBy: 'language',
  maxResults: 40,
};

const KEY_FIELDS = ['ad', 'tb', 'c411', 'tr4ker', 'ygg', 'tmdb'] as const;

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out;
}

function asTrimmedString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Decode le segment de config. Tolerant par conception : une config illisible
 * ne doit JAMAIS faire echouer une requete Stremio — on retombe sur les defauts
 * et l'addon reste utilisable (KissKH et VoirDrama ne demandent aucune cle).
 */
export function parseConfig(raw?: string | null): UserConfig {
  const cfg: UserConfig = {
    ...DEFAULT_CONFIG,
    subLangs: [...DEFAULT_CONFIG.subLangs],
    excludeQualities: [],
    sources: [],
  };
  if (!raw) return cfg;

  let parsed: unknown;
  try {
    // On accepte base64url (ce qu'on ecrit) ET base64 standard (liens colles a la
    // main, anciens liens) : "-" et "_" sont retablis, le padding est recalcule.
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    parsed = JSON.parse(json);
  } catch {
    return cfg;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return cfg;
  const o = parsed as Record<string, unknown>;

  for (const field of KEY_FIELDS) {
    const v = asTrimmedString(o[field]);
    if (v) cfg[field] = v;
  }

  const subLangs = asStringArray(o.subLangs);
  if (subLangs && subLangs.length > 0) cfg.subLangs = subLangs.map(normalizeLangCode);

  const excl = asStringArray(o.excludeQualities);
  if (excl) cfg.excludeQualities = excl;

  const sources = asStringArray(o.sources);
  if (sources) cfg.sources = sources;

  if (o.sortBy === 'quality' || o.sortBy === 'language') cfg.sortBy = o.sortBy;

  if (typeof o.maxResults === 'number' && Number.isFinite(o.maxResults)) {
    cfg.maxResults = Math.min(200, Math.max(1, Math.floor(o.maxResults)));
  }

  return cfg;
}

/** Encode une config en base64url sans padding (sur pour un segment d'URL). */
export function encodeConfig(cfg: Partial<UserConfig>): string {
  const compact: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    compact[k] = v;
  }
  return Buffer.from(JSON.stringify(compact), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Nuvio et Stremio veulent de l'ISO 639-2 (3 lettres) sur la ressource subtitles.
 * On accepte les codes a 2 lettres a l'entree et on les convertit, sinon un
 * utilisateur qui tape "fr" perdrait silencieusement ses sous-titres francais.
 */
const ISO_639_1_TO_2: Record<string, string> = {
  fr: 'fre', en: 'eng', ko: 'kor', ja: 'jpn', zh: 'chi', th: 'tha',
  es: 'spa', pt: 'por', de: 'ger', it: 'ita', ar: 'ara', ru: 'rus',
  id: 'ind', vi: 'vie', tr: 'tur', nl: 'dut', pl: 'pol',
};

export function normalizeLangCode(code: string): string {
  const c = code.trim().toLowerCase();
  if (c.length === 2 && ISO_639_1_TO_2[c]) return ISO_639_1_TO_2[c];
  return c;
}

/** Une source a-t-elle le droit de tourner pour cet utilisateur ? */
export function sourceEnabledForUser(cfg: UserConfig, sourceId: string): boolean {
  return cfg.sources.length === 0 || cfg.sources.includes(sourceId);
}

/** L'utilisateur a-t-il au moins un debrid configure ? */
export function hasDebrid(cfg: UserConfig): boolean {
  return Boolean(cfg.ad || cfg.tb);
}
