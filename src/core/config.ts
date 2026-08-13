// Configuration PAR UTILISATEUR, transportee dans le chemin d'installation.
//
// Regle du projet : l'operateur ne fournit AUCUNE cle. Tout ce qui donne acces a un
// service tiers (debrid, trackers, TMDB) vit ici, dans la config de chaque personne.
//
// Le blob est CHIFFRE (AES-256-GCM, cf. core/crypto.ts) des lors que TOKEN_SECRET est
// defini. Ce que ca change, exactement :
//
//   - le lien reste un jeton AU PORTEUR : qui l'a peut lire des flux a travers le
//     compte debrid de son proprietaire, puisque c'est le serveur qui dechiffre ;
//   - mais les cles ne sont plus EXTRACTIBLES du lien. Un lien colle dans un salon
//     Discord n'est plus une cle AllDebrid reutilisable ailleurs, decodable en trois
//     secondes avec un outil base64.
//
// La lecture du format en clair reste supportee : liens generes avant ce changement,
// et instances deployees sans TOKEN_SECRET.

import { chiffrer, dechiffrer, estChiffre, chiffrementDisponible } from './crypto';

export type SortBy = 'language' | 'quality' | 'size';

export interface UserConfig {
  /** Cle API AllDebrid. */
  ad?: string;
  /** Cle API TorBox. */
  tb?: string;
  /** Cle Torznab C411. */
  c411?: string;
  /** Cle Torznab Tr4ker. */
  tr4ker?: string;
  /** Cle API G3mini (tracker UNIT3D). */
  g3mini?: string;
  /** Cle API DigitalCore. */
  dcore?: string;
  /** Cle TMDB (optionnelle : enrichit en FR, sinon on sert Cinemeta + KissKH). */
  tmdb?: string;
  /** Langues de sous-titres, ISO 639-2, par ordre de preference. */
  subLangs: string[];
  /** Qualites exclues (opt-in). Vide = aucune exclusion. */
  excludeQualities: string[];
  /** Sources activees par leur id. Vide = toutes celles que l'operateur autorise. */
  sources: string[];
  /** Ce qui prime au tri : la langue, la qualite, ou le poids le plus leger. */
  sortBy: SortBy;
  /** Nombre maximum de flux renvoyes. 0 = pas de limite propre a l'utilisateur. */
  maxResults: number;

  /** N'afficher que ce dont la presence en cache a ete VERIFIEE. */
  cachedOnly: boolean;
  /** Pilier remonte en tete de liste. */
  priorite: 'aucune' | 'direct' | 'torrent';
  /** Bornes de resolution. Chaine vide = pas de borne. */
  minResolution: string;
  maxResolution: string;
  /** Qualite de source plancher (CAM, WEBRip, BluRay...). Vide = pas de borne. */
  minSource: string;
  /** Taille maximale en Go. 0 = illimite. */
  maxSizeGb: number;
  /** Formats a retirer (HEVC, HDR, DTS... ou texte libre). */
  excludeFormats: string[];
  /** Retirer les captations en salle. */
  excludeCam: boolean;
  /** Remonter les flux HDR a qualite comparable. */
  bonusHdr: boolean;
  /**
   * Attacher aussi les sous-titres a l'objet Stream, en plus de la ressource.
   *
   * Les lecteurs presentent les pistes d'une ressource /subtitles groupees par addon,
   * et rien ne garantit que les notres arrivent en tete — alors que ce sont celles qui
   * correspondent au flux qu'on sert. Attachees au flux, elles sont proposees avec lui.
   */
  subsSurFlux: boolean;
}

export const DEFAULT_CONFIG: UserConfig = {
  subLangs: ['fre', 'eng'],
  excludeQualities: [],
  sources: [],
  sortBy: 'language',
  maxResults: 40,
  // Tous les filtres sont NEUTRES par defaut. Quelqu'un qui installe sans rien regler
  // doit voir l'offre entiere ; c'est a lui de la restreindre s'il le souhaite.
  cachedOnly: false,
  priorite: 'aucune',
  minResolution: '',
  maxResolution: '',
  minSource: '',
  maxSizeGb: 0,
  excludeFormats: [],
  excludeCam: false,
  bonusHdr: false,
  subsSurFlux: true,
};

const KEY_FIELDS = ['ad', 'tb', 'c411', 'tr4ker', 'tmdb', 'g3mini', 'dcore'] as const;

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
    excludeFormats: [],
  };
  if (!raw) return cfg;

  let parsed: unknown;

  // Forme CHIFFREE (celle que /configure produit desormais) : les cles ne sont plus
  // extractibles du lien, meme si le lien reste un jeton au porteur.
  if (estChiffre(raw)) {
    parsed = dechiffrer(raw);
    if (!parsed) return cfg;
  } else {
    try {
      // Forme CLAIRE, conservee en lecture : liens generes avant l'ajout du
      // chiffrement, et instances sans TOKEN_SECRET. On accepte base64url (ce qu'on
      // ecrivait) ET base64 standard (liens recopies a la main).
      const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
    } catch {
      return cfg;
    }
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

  if (o.sortBy === 'quality' || o.sortBy === 'language' || o.sortBy === 'size') {
    cfg.sortBy = o.sortBy;
  }

  if (typeof o.maxResults === 'number' && Number.isFinite(o.maxResults)) {
    // 0 signifie « pas de limite de mon cote » — le plafond de l'operateur s'applique
    // toujours par-dessus.
    cfg.maxResults = Math.min(200, Math.max(0, Math.floor(o.maxResults)));
  }

  cfg.cachedOnly = o.cachedOnly === true;
  // Actif par defaut : on ne le desactive que si le champ dit explicitement false.
  cfg.subsSurFlux = o.subsSurFlux !== false;
  cfg.excludeCam = o.excludeCam === true;
  cfg.bonusHdr = o.bonusHdr === true;

  if (o.priorite === 'direct' || o.priorite === 'torrent') cfg.priorite = o.priorite;

  for (const champ of ['minResolution', 'maxResolution', 'minSource'] as const) {
    const v = asTrimmedString(o[champ]);
    if (v) cfg[champ] = v;
  }

  if (typeof o.maxSizeGb === 'number' && Number.isFinite(o.maxSizeGb) && o.maxSizeGb > 0) {
    cfg.maxSizeGb = Math.min(2000, o.maxSizeGb);
  }

  const formats = asStringArray(o.excludeFormats);
  if (formats) cfg.excludeFormats = formats.slice(0, 30);

  return cfg;
}

/**
 * Encode une config pour le chemin d'URL.
 *
 * CHIFFRE quand TOKEN_SECRET est disponible, en clair sinon — une instance mal
 * configuree doit rester utilisable, quitte a perdre cette protection. Le format
 * chiffre se reconnait a son prefixe `e1.`, ce qui permettra d'en changer.
 */
export function encodeConfig(cfg: Partial<UserConfig>): string {
  const compact = compacter(cfg);
  const chiffree = chiffrer(compact);
  if (chiffree) return chiffree;
  return Buffer.from(JSON.stringify(compact), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export { chiffrementDisponible };

/** Retire les champs vides : le lien ne transporte que ce qui a ete renseigne. */
function compacter(cfg: Partial<UserConfig>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    compact[k] = v;
  }
  return compact;
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

/**
 * Nom lisible d'une langue, pour les lecteurs qui affichent un libelle plutot qu'un
 * code. Nuvio en fait partie : ses propres providers renvoient
 * `{ url, language: 'English' }`, un NOM et non un code ISO.
 */
const NOMS_LANGUES: Record<string, string> = {
  fre: 'Français', eng: 'English', kor: '한국어 (Coréen)', jpn: '日本語 (Japonais)',
  chi: '中文 (Chinois)', tha: 'ไทย (Thaï)', spa: 'Español', por: 'Português',
  ger: 'Deutsch', ita: 'Italiano', ara: 'العربية (Arabe)', rus: 'Русский',
  ind: 'Indonesia', vie: 'Tiếng Việt', tur: 'Türkçe', dut: 'Nederlands',
  pol: 'Polski', km: 'ភាសាខ្មែរ (Khmer)', ms: 'Melayu',
};

export function nomLangue(code: string): string {
  return NOMS_LANGUES[code] || code.toUpperCase();
}

export function normalizeLangCode(code: string): string {
  const c = code.trim().toLowerCase();
  if (c.length === 2 && ISO_639_1_TO_2[c]) return ISO_639_1_TO_2[c];
  return c;
}

/**
 * Valeur d'AFFICHAGE, jamais une vraie cle.
 *
 * Le formulaire remplit les champs de cle avec des puces pour montrer qu'ils sont
 * deja renseignes, et il est cense ne jamais les renvoyer. On le verifie cote serveur
 * quand meme : une page en cache, une version ancienne ou une erreur de script
 * suffirait sinon a remplacer la vraie cle par des puces, et l'utilisateur perdrait
 * son acces sans avoir rien tape. Aucun service n'emet de cle faite uniquement de
 * puces, d'etoiles ou de points.
 */
export function estSentinelle(valeur: unknown): boolean {
  return typeof valeur === 'string' && valeur.length > 0 && /^[•*·.\s]+$/.test(valeur);
}

/** Une source a-t-elle le droit de tourner pour cet utilisateur ? */
export function sourceEnabledForUser(cfg: UserConfig, sourceId: string): boolean {
  return cfg.sources.length === 0 || cfg.sources.includes(sourceId);
}

/** L'utilisateur a-t-il au moins un debrid configure ? */
export function hasDebrid(cfg: UserConfig): boolean {
  return Boolean(cfg.ad || cfg.tb);
}
