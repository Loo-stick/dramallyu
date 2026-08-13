// Filtres avances et classement.
//
// Tout ce fichier est PUR : aucune entree/sortie, tout se teste sans reseau. C'est
// voulu — c'est le code qui decide ce que l'utilisateur voit ou ne voit pas, donc
// celui ou une erreur se remarque le moins et coute le plus cher.
//
// PRINCIPE QUI GOUVERNE TOUT LE FICHIER : on ne coupe jamais sur une information
// qu'on n'a pas. Une release dont on ne sait pas lire la resolution, la taille ou le
// codec PASSE les filtres. L'inverse — jeter par defaut — ferait disparaitre en
// silence des flux parfaitement valides, et l'utilisateur n'aurait aucun moyen de
// comprendre pourquoi sa liste s'est videe.

import type { Candidate } from '../sources/types';
import { releaseDetails } from '../sources/torrent/release';
import { normalizeQuality, isUnknownQuality, normalizeLanguage } from './prefs';

/** Echelle des resolutions. Sert aux bornes minimale et maximale. */
const RANG_RESOLUTION: Record<string, number> = {
  '360p': 1,
  '480p': 2,
  '576p': 3,
  '720p': 4,
  '1080p': 5,
  '4K': 6,
};

export function rangResolution(quality: string): number | null {
  if (isUnknownQuality(quality)) return null;
  return RANG_RESOLUTION[normalizeQuality(quality)] ?? null;
}

/**
 * Echelle de qualite de SOURCE, du pire au meilleur.
 *
 * Elle n'a rien a voir avec la resolution : un CAM peut etre annonce en 1080p et
 * rester illisible, tandis qu'un REMUX 720p est irreprochable. Les deux bornes sont
 * donc independantes.
 */
const RANG_SOURCE: Record<string, number> = {
  CAM: 0,
  TS: 0,
  DVDRip: 1,
  HDTV: 2,
  HDLight: 3,
  WEBRip: 4,
  WEB: 5,
  'WEB-DL': 5,
  BluRay: 6,
  REMUX: 7,
};

export const ECHELLE_SOURCE = ['CAM', 'DVDRip', 'HDTV', 'WEBRip', 'WEB-DL', 'BluRay', 'REMUX'];

/** Detecte une captation en salle, qui n'est pas annoncee par `releaseDetails`. */
export function estCam(nom: string): boolean {
  return /\b(cam|camrip|hdcam|ts|telesync|hdts|tc|telecine|scr|screener)\b/i.test(nom);
}

export function rangSource(nom: string): number | null {
  if (estCam(nom)) return 0;
  const source = releaseDetails(nom).source;
  return source ? (RANG_SOURCE[source] ?? null) : null;
}

/** Formats proposes a l'exclusion, avec ce qui les reconnait dans un nom de release. */
export const FORMATS_EXCLUABLES: Record<string, RegExp> = {
  HEVC: /\b(hevc|x265|h\.?265)\b/i,
  AV1: /\bav1\b/i,
  HDR: /\bhdr(10)?\+?\b/i,
  'Dolby Vision': /\bdv\b|\bdolby[-. ]?vision\b/i,
  DTS: /\bdts\b/i,
  TrueHD: /\btruehd\b/i,
  Atmos: /\batmos\b/i,
  'x264': /\b(x264|h\.?264|avc)\b/i,
};

/**
 * Le format est-il present dans ce nom ?
 *
 * Un format inconnu de la table est cherche comme un MOT, pas comme une sous-chaine :
 * l'utilisateur peut taper ce qu'il veut, et « DD » ne doit pas faire disparaitre
 * tous les « DDP5.1 » ni « Squid ».
 */
export function contientFormat(nom: string, format: string): boolean {
  const connu = FORMATS_EXCLUABLES[format];
  if (connu) return connu.test(nom);
  const echappe = format.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${echappe}\\b`, 'i').test(nom);
}

export interface Filtres {
  /** Ne montrer que ce dont on a VERIFIE la presence en cache. */
  cachedOnly: boolean;
  /** Resolution plancher / plafond. Chaine vide = pas de borne. */
  minResolution: string;
  maxResolution: string;
  /** Qualite de source plancher. Chaine vide = pas de borne. */
  minSource: string;
  /** Taille maximale en gigaoctets. 0 = pas de limite. */
  maxSizeGb: number;
  /** Formats a retirer (table ci-dessus, ou texte libre). */
  excludeFormats: string[];
  /** Retirer les captations en salle. */
  excludeCam: boolean;
}

export interface EtatFlux {
  candidate: Candidate;
  /** Presence en cache VERIFIEE. `undefined` = non verifiable. */
  cached?: boolean;
}

/**
 * Ce flux passe-t-il les filtres ?
 *
 * Chaque test commence par verifier qu'on dispose bien de l'information. Un `null`
 * signifie « non mesurable » et laisse passer.
 */
export function passeFiltres(etat: EtatFlux, f: Filtres): boolean {
  const c = etat.candidate;
  const nom = c.title;

  // « Uniquement ce qui est pret » = ce qui demarre tout de suite.
  //
  // UN FLUX DIRECT PASSE TOUJOURS : il ne traverse aucun debrideur, donc il n'a pas
  // d'etat de cache — et il est pourtant le plus immediat de la liste. L'ecarter au
  // motif qu'il n'a rien a debrider etait un contresens, et il se voyait : l'addon
  // affiche `[▶ ⚡]` sur ces flux, c'est-a-dire l'inverse de ce que le filtre en
  // faisait. Constate en production sur un drama que KissKH servait parfaitement,
  // et qui rendait une liste vide.
  //
  // Pour le reste, `undefined` signifie « invérifiable » (un lien DDL n'a pas de
  // somme de controle) : l'utilisateur a demande ce qui est SUR, on ne le garde donc
  // pas — mais ce n'est pas la meme chose qu'« absent ».
  if (f.cachedOnly && c.kind !== 'direct' && etat.cached !== true) return false;

  const rang = rangResolution(c.quality);
  if (rang !== null) {
    const min = f.minResolution ? RANG_RESOLUTION[f.minResolution] : undefined;
    const max = f.maxResolution ? RANG_RESOLUTION[f.maxResolution] : undefined;
    if (min !== undefined && rang < min) return false;
    if (max !== undefined && rang > max) return false;
  }

  if (f.excludeCam && estCam(nom)) return false;

  if (f.minSource) {
    const plancher = RANG_SOURCE[f.minSource];
    const source = rangSource(nom);
    if (plancher !== undefined && source !== null && source < plancher) return false;
  }

  if (f.maxSizeGb > 0 && c.sizeBytes) {
    if (c.sizeBytes > f.maxSizeGb * 1024 ** 3) return false;
  }

  for (const format of f.excludeFormats) {
    if (format && contientFormat(nom, format)) return false;
  }

  return true;
}

export type TriPar = 'language' | 'quality' | 'size';
export type Priorite = 'aucune' | 'direct' | 'torrent';

export interface OptionsTri {
  langOrder: string[];
  sortBy: TriPar;
  /** Pilier remonte en tete, quel que soit le reste. */
  priorite: Priorite;
  /** Remonte les flux HDR / Dolby Vision a qualite comparable. */
  bonusHdr: boolean;
}

const SCORE_RESOLUTION: Record<string, number> = {
  '4K': 6,
  '1080p': 5,
  '720p': 4,
  '576p': 3,
  '480p': 2,
  '360p': 1,
};

function scoreQualite(c: Candidate, bonusHdr: boolean): number {
  // Une resolution non mesuree vaut 720p : ni promue, ni enterree.
  const base = isUnknownQuality(c.quality) ? 4 : (SCORE_RESOLUTION[normalizeQuality(c.quality)] ?? 4);
  if (!bonusHdr) return base;
  return releaseDetails(c.title).hdr ? base + 0.5 : base;
}

function rangLangue(langue: string, ordre: string[]): number {
  const i = ordre.indexOf(normalizeLanguage(langue));
  return i === -1 ? 100 : i;
}

function rangPriorite(c: Candidate, priorite: Priorite): number {
  if (priorite === 'aucune') return 0;
  if (priorite === 'direct') return c.kind === 'direct' ? 0 : 1;
  return c.kind === 'torrent' ? 0 : 1;
}

/**
 * Comparateur complet.
 *
 * L'ordre des criteres n'est pas negociable : ce qui est PRET passe toujours devant,
 * car un flux injouable en tete de liste ne sert a personne, si bien classe soit-il
 * par ailleurs. Vient ensuite la priorite de pilier choisie, puis le critere de tri.
 */
export function comparer(a: EtatFlux, b: EtatFlux, o: OptionsTri): number {
  const pret = (e: EtatFlux): number => (e.cached === true ? 0 : 1);
  const parPret = pret(a) - pret(b);
  if (parPret !== 0) return parPret;

  const parPilier = rangPriorite(a.candidate, o.priorite) - rangPriorite(b.candidate, o.priorite);
  if (parPilier !== 0) return parPilier;

  const langue = rangLangue(a.candidate.language, o.langOrder) - rangLangue(b.candidate.language, o.langOrder);
  const qualite = scoreQualite(b.candidate, o.bonusHdr) - scoreQualite(a.candidate, o.bonusHdr);
  // « Leger » : le plus petit d'abord. Une taille inconnue part en fin de liste plutot
  // que de passer pour un fichier de 0 octet.
  const taille =
    (a.candidate.sizeBytes ?? Number.MAX_SAFE_INTEGER) - (b.candidate.sizeBytes ?? Number.MAX_SAFE_INTEGER);
  const sources = (b.candidate.seeders ?? 0) - (a.candidate.seeders ?? 0);

  switch (o.sortBy) {
    case 'quality':
      return qualite || langue || sources;
    case 'size':
      return taille || qualite || langue;
    default:
      return langue || qualite || sources;
  }
}
