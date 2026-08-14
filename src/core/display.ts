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
import { releaseDetails, parseRelease } from '../sources/torrent/release';

/**
 * Une piste attachee a un flux.
 *
 * `lang` est le code ISO 639-2 attendu par Stremio ; `language` le libelle lisible
 * qu'attendent les providers de Nuvio. On emet les deux : un champ vide suffit a
 * faire ignorer ou reléguer la piste.
 */
export interface PisteFlux {
  id: string;
  url: string;
  lang: string;
  /** Libelle lisible. Toleré ici : Stremio seul lit ce chemin, et il l'ignore. */
  language?: string;
  default?: boolean;
}

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
  subtitles?: PisteFlux[];
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
  sousTitres?: PisteFlux[];
  /**
   * Identite de l'oeuvre, telle que /stream l'a resolue. Sert UNIQUEMENT a fabriquer
   * un `behaviorHints.filename` analysable ; l'affichage n'en depend pas.
   */
  annee?: number;
  saison?: number;
  episode?: number;
  /** Titre canonique, sans mention de saison. */
  titreOeuvre?: string;
  /** Episodes de la saison demandee : sert a annoncer le poids d'UN episode. */
  episodesSaison?: number;
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

/**
 * Poids d'un episode dans un pack, quand les deux informations sont la.
 *
 * Le « ≈ » n'est pas une coquetterie : les episodes d'une saison n'ont pas tous le
 * meme poids, et annoncer une valeur exacte serait faux. L'ordre de grandeur suffit a
 * repondre a la seule question qui compte — est-ce que ca rentre dans mon plafond ?
 */
function poidsEpisode(total?: number, episodes?: number): string | null {
  if (!total || !episodes || episodes < 2) return null;
  const taille = formatSize(total / episodes);
  return taille ? `≈ ${taille} l'episode` : null;
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

/**
 * Ce titre est-il DEJA un nom de release ?
 *
 * Question decisive : un nom de release porte la resolution, le codec, la team, la
 * provenance. Le reecrire ferait PERDRE tout ça. On ne fabrique donc un nom que
 * lorsqu'on n'en a pas — typiquement les sources directes, dont le titre est nu.
 */
function estNomDeRelease(titre: string): boolean {
  const d = releaseDetails(titre);
  if (d.source || d.video || d.audio || d.team) return true;
  return /\b\d{3,4}p\b/i.test(titre) || /\bs\d{1,2}(e\d{1,3})?\b/i.test(titre) || /\b(19|20)\d{2}\b/.test(titre);
}

const deuxChiffres = (n: number): string => String(n).padStart(2, '0');

/**
 * Nom de release FABRIQUE, pour les flux qui n'en ont pas.
 *
 * AIOStreams analyse `behaviorHints.filename` avec un parseur de noms de release, et
 * ne regarde la description que si ce champ est absent. Un titre nu — « Sex Plate 17 »
 * — ne lui livre donc ni annee ni resolution, et son filtre « Year Matching » supprime
 * le flux. Verifie dans ses journaux : « Year Matching (3) → 1x Sex Plate 17 -
 * Unknown Year ».
 *
 * Aucun emoji ni puce ici, le parseur ne les gere pas : ce champ n'est PAS de
 * l'affichage, la mise en forme lisible vit dans `description`.
 *
 * Regle constante du projet : on n'ecrit que ce qu'on sait. Une resolution non mesuree
 * ou une provenance inconnue sont OMISES plutot qu'inventees — un « 1080p » de
 * complaisance ferait trier AIOStreams sur une valeur fausse, ce qui est pire que de
 * le laisser sans.
 */
function nomDeReleaseFabrique(c: Candidate, opts: FormatOptions, resolution: string): string {
  const brut = opts.titreOeuvre || c.title;
  // « Squid Game Season 1 » -> « Squid Game » : la saison est reecrite en SxxExx juste
  // apres, la garder donnerait « Squid Game Season 1 S01E01 ».
  const titre = brut.replace(/\s*[-–—]?\s*(saison|season)\s*\d{1,2}\s*$/i, '').trim();

  const morceaux: string[] = [titre];

  if (opts.saison !== undefined) {
    morceaux.push(`S${deuxChiffres(opts.saison)}E${deuxChiffres(opts.episode ?? 1)}`);
  } else if (opts.annee) {
    morceaux.push(`(${opts.annee})`);
  }

  if (!isUnknownQuality(c.quality)) morceaux.push(resolution);
  morceaux.push(normalizeLanguage(c.language));

  const details = releaseDetails(c.title);
  if (details.source) morceaux.push(details.source);

  return morceaux.join(' ');
}

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
  // PACK ou FICHIER : deux pictogrammes distincts, parce que ce sont deux choses
  // differentes et que la confusion coute cher. Un pack de 23 Go effraie a juste titre
  // si on croit devoir le telecharger — alors qu'on n'en lit qu'un episode.
  //
  // Le carton porte le nom du DOSSIER. La ligne suivante annonce l'episode qui en sera
  // extrait. On n'affiche PAS un nom de fichier : il n'existe pas encore a cet
  // instant, le debrideur n'ouvre le dossier qu'au moment du Play. Annoncer un nom
  // qu'on ne connait pas serait une promesse en l'air.
  const estPack = parseRelease(candidate.title).isPack;
  const estLibelleFabrique = candidate.title.toLowerCase().startsWith(source.toLowerCase());
  if (!estLibelleFabrique) lignes.push(`${estPack ? '📦' : '🗂️'} ${candidate.title}`);
  if (estPack && opts.saison !== undefined && opts.episode !== undefined) {
    const cible = `S${String(opts.saison).padStart(2, '0')}E${String(opts.episode).padStart(2, '0')}`;
    const part = poidsEpisode(candidate.sizeBytes, opts.episodesSaison);
    lignes.push(`📄 ${cible} extrait du pack${part ? ` • ${part}` : ''}`);
  }

  if (candidate.subs && candidate.subs.length > 0) {
    const avecFr = candidate.subs.some((s) => s.lang === 'fre');
    lignes.push(`💬 ${candidate.subs.length} sous-titres${avecFr ? ' dont FR' : ''}`);
  } else if (candidate.languesIntegrees && candidate.languesIntegrees.length > 0) {
    // Pistes INTEGREES au fichier, lues dans le MediaInfo publie par le tracker. On
    // les distingue des sous-titres qu'on fournit nous-memes : celles-ci sont calees
    // au frame pres sur cette video, les notres viennent d'un autre encodage.
    //
    // Le francais est nomme en clair quand il est la : c'est la seule question que se
    // pose l'utilisateur devant une liste de flux.
    const fr = candidate.languesIntegrees.includes('fre');
    const n = candidate.languesIntegrees.length;
    lignes.push(`💬 ${n} piste${n > 1 ? 's' : ''} intégrée${n > 1 ? 's' : ''}${fr ? ' — FR INCLUS' : ' (pas de FR)'}`);
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

  // AIOStreams parse ce champ pour en extraire annee/resolution/langue/episode, et ne
  // regarde la description QUE si ce champ est absent. Il doit donc toujours etre
  // rempli, et toujours ressembler a un nom de release.
  //
  // On garde le titre tel quel quand c'en est deja un — il porte le codec, la team et
  // la provenance, que notre version fabriquee n'aurait pas. Sinon on en fabrique un a
  // partir de l'identite deja resolue par /stream. `fileHint` n'entre jamais ici : ce
  // n'est pas un nom de fichier mais un motif d'episode (« s01e09 »).
  stream.behaviorHints!.filename =
    !estLibelleFabrique && estNomDeRelease(candidate.title)
      ? candidate.title
      : nomDeReleaseFabrique(candidate, opts, quality);
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
