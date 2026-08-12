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
import { normalizeLanguage, normalizeQuality } from './prefs';

export interface StremioStream {
  name: string;
  description: string;
  url?: string;
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

/** Etiquette de langue lisible, sans dependre d'une couleur. */
function languageLabel(language: string): string {
  switch (normalizeLanguage(language)) {
    case 'VF':
      return '[VF] Francais';
    case 'VOSTFR':
      return '[VOSTFR] ST francais';
    case 'MULTI':
      return '[MULTI] Multilingue';
    default:
      return '[VO] Version originale';
  }
}

function kindLabel(kind: Candidate['kind']): string {
  switch (kind) {
    case 'direct':
      return 'Direct';
    case 'torrent':
      return 'Torrent';
    default:
      return 'DDL';
  }
}

export interface FormatOptions {
  /** URL de lecture finale (directe, ou notre /resolve pour le debrid). */
  playUrl?: string;
  /** Vrai si la lecture passera par un debrideur (affiche le rappel a l'utilisateur). */
  viaDebrid?: boolean;
  /** Nom du debrideur qui servira ce flux. */
  debridName?: string;
}

export function toStremioStream(candidate: Candidate, opts: FormatOptions): StremioStream {
  const quality = normalizeQuality(candidate.quality);
  const size = formatSize(candidate.sizeBytes);

  // Ligne 1 : ce que l'utilisateur repere en un coup d'oeil dans une liste longue.
  const name = `${ADDON_LABEL}\n${quality}`;

  const lines: string[] = [];
  lines.push(candidate.title);

  const facts: string[] = [languageLabel(candidate.language)];
  if (size) facts.push(size);
  if (candidate.seeders !== undefined) facts.push(`${candidate.seeders} sources`);
  lines.push(facts.join(' | '));

  const origin: string[] = [`${kindLabel(candidate.kind)} - ${candidate.sourceId}`];
  if (opts.viaDebrid && opts.debridName) origin.push(`via ${opts.debridName}`);
  if (candidate.subs && candidate.subs.length > 0) {
    const hasFr = candidate.subs.some((s) => s.lang === 'fre');
    origin.push(hasFr ? `${candidate.subs.length} ST dont FR` : `${candidate.subs.length} ST`);
  }
  lines.push(origin.join(' | '));

  const stream: StremioStream = {
    name,
    description: lines.join('\n'),
    behaviorHints: {
      // Le bingeGroup permet la lecture automatique de l'episode suivant en gardant
      // la meme source : on le rend stable par (source, qualite, langue).
      bingeGroup: `dramallyu-${candidate.sourceId}-${quality}-${normalizeLanguage(candidate.language)}`,
    },
  };

  // AIOStreams parse ce champ pour en extraire resolution/codec/langue : on ne le
  // renseigne QUE quand on a un vrai nom de release, jamais avec un libelle invente,
  // sinon on lui fait deduire n'importe quoi.
  if (candidate.fileHint) stream.behaviorHints!.filename = candidate.fileHint;
  if (candidate.sizeBytes) stream.behaviorHints!.videoSize = candidate.sizeBytes;

  if (opts.playUrl) {
    stream.url = opts.playUrl;
    if (candidate.headers && Object.keys(candidate.headers).length > 0) {
      stream.behaviorHints!.proxyHeaders = { request: candidate.headers };
      stream.behaviorHints!.notWebReady = true;
    }
  }

  return stream;
}
