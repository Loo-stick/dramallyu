// Mise en forme des flux pour Stremio, Nuvio et AIOStreams.
//
// Ces trois clients lisent la meme reponse mais pas de la meme façon :
//
//  - Stremio affiche `name` (petit, a gauche) et `description` (le corps).
//  - Nuvio est plus avare : il faut que l'essentiel tienne dans les premieres lignes.
//  - AIOStreams ne LIT pas seulement, il PARSE : son analyseur de titres extrait
//    resolution, codec et langue depuis le nom de fichier et la description. D'ou
//    `behaviorHints.filename` renseigne des qu'on connait un vrai nom de release —
//    c'est ce qui permet a AIOStreams de trier correctement nos flux parmi les autres.
//
// Accessibilite : aucune information n'est portee par la couleur seule. Les pastilles
// sont des SYMBOLES et chaque symbole est double d'un texte.

import type { Candidate } from '../sources/types';
import { normalizeLanguage, normalizeQuality, isUnknownQuality } from './prefs';
import { releaseDetails } from '../sources/torrent/release';

export interface StremioStream {
  name: string;
  description: string;
  url?: string;
  /**
   * Pistes attachees au flux lui-meme.
   *
   * Complementaire de la ressource /subtitles, pas concurrent : la ressource repond
   * pour n'importe quel flux, y compris ceux d'un autre addon, tandis que celles-ci
   * accompagnent LE flux qu'on sert — et sont donc proposees avec lui plutot que
   * reléguees derriere les autres addons de sous-titres.
   */
  subtitles?: { id: string; url: string; lang: string }[];
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: {
    bingeGroup?: string;
    filename?: string;
    videoSize?: number;
    notWebReady?: boolean;
    proxyHeaders?: { request?: Record<string, string> };
  };
}

const ADDON_LABEL = 'Dramallyu';

export function formatSize(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Etiquette de langue : pictogramme ET mot.
 *
 * Le mot n'est pas une redondance. Un drapeau seul encode la langue par la COULEUR —
 * 🇫🇷, 🇳🇱 et 🇷🇺 ont exactement la meme forme et ne different que par leurs teintes.
 * Un utilisateur daltonien ne peut pas les distinguer. Le pictogramme donne le repere
 * visuel rapide, le mot porte l'information.
 */
function languageLabel(language: string): string {
  switch (normalizeLanguage(language)) {
    case 'VF':
      return '🇫🇷 VF';
    case 'VOSTFR':
      return '🇫🇷 VOSTFR';
    case 'MULTI':
      return '🌐 MULTI';
    default:
      return '🔤 VO';
  }
}

export interface FormatOptions {
  /** URL de lecture finale (directe, ou notre /resolve pour le debrid). */
  playUrl?: string;
  /** Vrai si la lecture passera par un debrideur (affiche le rappel a l'utilisateur). */
  viaDebrid?: boolean;
  /** Debrideur qui servira reellement ce flux. */
  debrid?: 'alldebrid' | 'torbox';
  /** Pistes a attacher au flux, deja converties en URL servies par nous. */
  sousTitres?: { id: string; url: string; lang: string }[];
  /**
   * Etat du cache : vrai = pret a lire, faux = a telecharger,
   * `undefined` = ON NE SAIT PAS (typiquement un lien DDL, dont la disponibilite ne
   * se verifie pas a l'avance). Les trois cas restent distincts : promettre une
   * lecture immediate qui echoue, ou decourager un flux jouable, sont deux erreurs
   * symetriques.
   */
  cached?: boolean;
}

/**
 * Etiquette de tete : d'ou sortira le flux, et s'il part tout de suite.
 *
 * Le ⚡ ne vit QU'ICI. Il servait aussi de puce decorative en tete de la ligne
 * technique, alors qu'il a un sens etabli chez les addons de streaming — « en
 * cache, demarre immediatement ». Le montrer a deux endroits pour deux raisons
 * differentes le vidait de son sens.
 *
 *   [TB ⚡]  TorBox, fichier deja pret
 *   [AD ⏳]  AllDebrid, telechargement a lancer
 *   [▶ ⚡]   lecture directe, aucun debrideur en jeu
 */
function badge(opts: FormatOptions, kind: Candidate['kind']): string {
  if (kind === 'direct') return '[▶ ⚡] ';
  const service = opts.debrid === 'torbox' ? 'TB' : opts.debrid === 'alldebrid' ? 'AD' : null;
  if (!service) return '';
  const etat = opts.cached === true ? ' ⚡' : opts.cached === false ? ' ⏳' : '';
  return `[${service}${etat}] `;
}

/** Assemble une ligne en sautant les segments inconnus, sans laisser de « • » orphelin. */
function ligne(prefixe: string, segments: (string | null | undefined)[]): string | null {
  const utiles = segments.filter((s): s is string => Boolean(s));
  if (utiles.length === 0) return null;
  return `${prefixe}${utiles.join(' • ')}`;
}

/** Nom de source lisible, plutot que l'identifiant technique. */
const NOMS_SOURCES: Record<string, string> = {
  kisskh: 'KissKH',
  voirdrama: 'VoirDrama',
  nyaa: 'Nyaa',
  c411: 'C411',
  tr4ker: 'Tr4ker',
  zonetelechargement: 'Zone-Telechargement',
  wawacity: 'Wawacity',
};

export function toStremioStream(candidate: Candidate, opts: FormatOptions): StremioStream {
  // On affiche la qualite BRUTE quand elle n'a pas ete mesuree.
  //
  // `normalizeQuality` traduit « HD » en « 1080p », ce qui est un bon repli pour
  // TRIER, mais afficher « 1080p » sur une release qui annonce seulement « HD »
  // revient a promettre une resolution qu'on ne connait pas. L'utilisateur le
  // decouvrirait a la lecture.
  const quality = isUnknownQuality(candidate.quality)
    ? (candidate.quality || 'HD').toUpperCase()
    : normalizeQuality(candidate.quality);

  const size = formatSize(candidate.sizeBytes);
  const details = releaseDetails(candidate.title);
  const source = NOMS_SOURCES[candidate.sourceId] || candidate.sourceId;

  const lignes: string[] = [];

  // Ligne 1 — la technique video, du plus decisif au plus accessoire.
  // Seul l'hebergeur DDL termine cette ligne : le debrideur et la disponibilite sont
  // deja dans l'etiquette de tete, les repeter ici serait du bruit.
  const destination = candidate.kind === 'ddl' ? candidate.ddlHost : null;
  lignes.push(ligne('🎞️ ', [quality, details.source, details.hdr, destination]) ?? `🎞️ ${quality}`);

  // Ligne 2 — langue, poids, provenance : le trio qu'on compare entre deux entrees.
  const l2 = ligne('', [
    languageLabel(candidate.language),
    size ? `💾 ${size}` : null,
    candidate.seeders !== undefined ? `👤 ${candidate.seeders}` : null,
    source,
  ]);
  if (l2) lignes.push(l2);

  // Ligne 3 — codecs et team. Absente sur les sources directes, qui n'en disent rien :
  // mieux vaut une ligne en moins qu'une ligne vide.
  const l3 = ligne('🎧 ', [details.video, details.audio, details.team]);
  if (l3) lignes.push(l3);

  // Ligne 4 — le nom de release, EN ENTIER. Il est souvent long, mais c'est le seul
  // juge de paix quand deux entrees se ressemblent : le tronquer coupe justement la
  // fin, la ou vivent le codec et la team qui les distinguent.
  // Omise quand le titre n'est qu'un libelle fabrique par la source (« VoirDrama -
  // voe ») : repeter le nom de la source sous une icone de fichier ne renseigne pas,
  // ca occupe juste une ligne.
  // On affiche le TITRE, pas `fileHint` : ce dernier n'est pas un nom de fichier mais
  // le motif d'episode (« s01e09 ») qui sert au debrideur a choisir dans un pack.
  // L'afficher donnait une ligne « 🗂️ s01e09 », qui n'apprend rien.
  const estLibelleFabrique = candidate.title.toLowerCase().startsWith(source.toLowerCase());
  if (!estLibelleFabrique) lignes.push(`🗂️ ${candidate.title}`);

  if (candidate.subs && candidate.subs.length > 0) {
    const avecFr = candidate.subs.some((s) => s.lang === 'fre');
    lignes.push(`💬 ${candidate.subs.length} sous-titres${avecFr ? ' dont FR' : ''}`);
  }

  const stream: StremioStream = {
    name: `${badge(opts, candidate.kind)}${ADDON_LABEL}`,
    description: lignes.join('\n'),
    behaviorHints: {
      // Le bingeGroup permet la lecture automatique de l'episode suivant en gardant
      // la meme source : on le rend stable par (source, qualite, langue).
      bingeGroup: `dramallyu-${candidate.sourceId}-${quality}-${normalizeLanguage(candidate.language)}`,
    },
  };

  // AIOStreams parse ce champ pour en extraire resolution/codec/langue : on lui donne
  // le nom de release, jamais `fileHint` (un motif d'episode) ni un libelle fabrique
  // par la source — il en deduirait n'importe quoi.
  if (!estLibelleFabrique) stream.behaviorHints!.filename = candidate.title;
  if (candidate.sizeBytes) stream.behaviorHints!.videoSize = candidate.sizeBytes;

  if (opts.sousTitres && opts.sousTitres.length > 0) stream.subtitles = opts.sousTitres;

  if (opts.playUrl) {
    stream.url = opts.playUrl;
    if (candidate.headers && Object.keys(candidate.headers).length > 0) {
      stream.behaviorHints!.proxyHeaders = { request: candidate.headers };
      stream.behaviorHints!.notWebReady = true;
    }
  }

  return stream;
}
