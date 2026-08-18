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
import { releaseDetails, parseRelease } from '../sources/torrent/release';
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
  /**
   * La verification a-t-elle seulement EU LIEU ?
   *
   * A froid, le fan-out consomme le budget et la verification de disponibilite est
   * sautee ou expire. Elle rendait alors une carte vide, que `cachedOnly` lisait comme
   * « rien n'est pret » : la liste entiere disparaissait, puis tout revenait au
   * rechargement. Constate en production — deux requetes simultanees et identiques
   * rendaient 0 et 3 flux.
   *
   * C'est la regle de la maison, appliquee ici aussi : ON NE COUPE JAMAIS SUR UNE
   * INFORMATION QU'ON N'A PAS.
   */
  verificationFaite: boolean;
  /** Resolution plancher / plafond. Chaine vide = pas de borne. */
  minResolution: string;
  maxResolution: string;
  /** Qualite de source plancher. Chaine vide = pas de borne. */
  minSource: string;
  /** Taille maximale en gigaoctets. 0 = pas de limite. */
  maxSizeGb: number;
  /**
   * Nombre d'episodes de la saison demandee, quand on le connait.
   *
   * Un plafond de taille vise le fichier qu'on va LIRE. Sur un pack, le poids annonce
   * est celui du dossier entier : juger « Squid Game S01 » (23 Go) contre un plafond
   * de 10 Go supprimait une release dont chaque episode pese 2,6 Go — soit tres en
   * dessous de ce que l'utilisateur a demande. On divise donc par le compte.
   */
  episodesSaison?: number;
  /** Formats a retirer (table ci-dessus, ou texte libre). */
  excludeFormats: string[];
  /** Retirer les captations en salle. */
  excludeCam: boolean;
  /** Ne garder que ce qui annonce du francais. */
  frOnly?: boolean;
  /** L'utilisateur accepte d'envoyer le `.torrent` (donc sa passkey) au debrideur. */
  envoyerTorrent?: boolean;
  /** Ne garder que ce dont la PRESENCE de francais est etablie. */
  frStrict?: boolean;
}

/**
 * Seeders en dessous desquels un torrent NON MIS EN CACHE est une impasse.
 *
 * Le debrideur doit trouver des pairs pour telecharger ce qu'il n'a pas deja. A zero
 * seeder il n'en trouvera aucun : l'entree s'affiche comme jouable, on la choisit, et
 * il ne se passe rien. Constate sur « 1 Litre of Tears », ou une release Nyaa a
 * 0 seeder etait proposee au meme rang que les autres.
 *
 * Le seuil ne s'applique QU'AUX torrents a debrider : un torrent deja en cache n'a
 * besoin de personne, et un lien direct ou DDL n'a pas de pairs du tout.
 */
const SEEDERS_MINIMUM = 5;

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
  if (f.cachedOnly && f.verificationFaite && c.kind !== 'direct' && etat.cached !== true) return false;

  const rang = rangResolution(c.quality);
  if (rang !== null) {
    const min = f.minResolution ? RANG_RESOLUTION[f.minResolution] : undefined;
    const max = f.maxResolution ? RANG_RESOLUTION[f.maxResolution] : undefined;
    if (min !== undefined && rang < min) return false;
    if (max !== undefined && rang > max) return false;
  }

  if (f.excludeCam && estCam(nom)) return false;

  // « Uniquement le francais » : on n'ecarte que ce dont on SAIT qu'il n'en a pas.
  //
  // C'est la regle qui gouverne tout ce fichier, appliquee ici aussi : on ne coupe pas
  // sur une information qu'on n'a pas. Couper sur l'ignorance faisait disparaitre des
  // releases parfaitement francaises — constate sur « Pursuit of Jade », ou le meme
  // fichier passait chez DarkPeers, qui publie son MediaInfo, et disparaissait chez
  // DigitalCore, qui n'en publie pas.
  //
  // Ce qu'on ECARTE, c'est ce qui est etabli sans francais : un fichier dont on a lu
  // les pistes, ou une release dont le MediaInfo est publie. Le reste passe, quitte a
  // decevoir parfois — mieux vaut un flux de trop qu'un flux manquant qu'on ne saura
  // jamais avoir perdu.
  if (f.frOnly && sansFrancaisAvere(c)) return false;

  // Version severe : on ne garde que ce dont la PRESENCE de francais est etablie.
  // L'inconnu tombe, ce qui est exactement l'inverse de la regle precedente — et c'est
  // assume : sur un titre sans piste francaise nulle part, une liste vide vaut mieux
  // qu'un flux que la personne a qui on l'installe ne pourra pas suivre.
  if (f.frStrict && !porteDuFrancais(c)) return false;

  // Tracker prive, pas encore en cache, et l'utilisateur refuse d'envoyer le
  // `.torrent` : le debrideur n'aura qu'un hash nu, donc aucun annonceur, donc aucun
  // pair. Cette entree ne peut pas aboutir — on ne la propose pas.
  //
  // Comme pour « uniquement ce qui est pret », on n'applique la regle que si la
  // verification a REELLEMENT eu lieu : sans elle `cached` vaut `undefined` pour tout
  // le monde, et l'on ferait disparaitre l'ensemble des trackers prives.
  if (
    f.envoyerTorrent === false &&
    f.verificationFaite &&
    c.kind === 'torrent' &&
    TRACKERS_PRIVES.has(c.sourceId) &&
    etat.cached !== true
  ) {
    return false;
  }

  // Torrent a debrider et trop peu de pairs : il ne se telechargera pas. On ne coupe
  // que sur un nombre CONNU — `undefined` veut dire que la source ne l'annonce pas, et
  // l'ignorance ne doit pas faire disparaitre un flux valable.
  if (
    c.kind === 'torrent' &&
    etat.cached !== true &&
    typeof c.seeders === 'number' &&
    c.seeders < SEEDERS_MINIMUM
  ) {
    return false;
  }

  if (f.minSource) {
    const plancher = RANG_SOURCE[f.minSource];
    const source = rangSource(nom);
    if (plancher !== undefined && source !== null && source < plancher) return false;
  }

  if (f.maxSizeGb > 0 && c.sizeBytes) {
    if (tailleJugee(c, f.episodesSaison) > f.maxSizeGb * 1024 ** 3) return false;
  }

  for (const format of f.excludeFormats) {
    if (format && contientFormat(nom, format)) return false;
  }

  return true;
}

/**
 * Poids a comparer au plafond de l'utilisateur.
 *
 * Sur un pack dont on connait le nombre d'episodes, c'est le poids d'UN episode : le
 * debrideur n'ouvre que ce fichier, les autres ne sont jamais telecharges.
 *
 * Sans ce compte, on rend le poids brut plutot que de deviner. Regle constante du
 * projet : on ne coupe pas sur une information qu'on n'a pas — mais ici l'inconnu
 * penche du cote severe, alors on prefere laisser passer, cf. `passeFiltres`.
 */
export function tailleJugee(c: Candidate, episodesSaison?: number): number {
  const brut = c.sizeBytes ?? 0;
  if (!parseRelease(c.title).isPack) return brut;
  if (!episodesSaison || episodesSaison < 2) return brut;
  return brut / episodesSaison;
}

/**
 * Cette entree annonce-t-elle du francais ?
 *
 * Deux niveaux de certitude, et ils ne se valent pas. Une source directe dont on a
 * enumere les pistes : on SAIT. Une release torrent : on lit son etiquette, qui reste
 * une declaration — d'ou l'importance de ne pas sur-interpreter « Multi Subs », cf.
 * `languageOf`.
 */
/**
 * Sait-on avec CERTITUDE que cette entree n'a pas de francais ?
 *
 * Trois cas, et un seul justifie d'ecarter :
 *   - les pistes du fichier ont ete lues, ou le tracker a publie son MediaInfo, et le
 *     francais n'y est pas -> on sait, on ecarte ;
 *   - la source a enumere ses sous-titres et le francais n'y est pas -> on sait aussi ;
 *   - on n'a que le titre -> on ne sait rien, et un titre muet ne prouve rien. On garde.
 */
export function sansFrancaisAvere(c: Candidate): boolean {
  if (c.languesIntegrees) return !c.languesIntegrees.includes('fre');
  if (c.subs && c.subs.length > 0) return !c.subs.some((t) => t.lang === 'fre');
  return false;
}

/**
 * Trackers dont l'ORIGINE vaut preuve de francais.
 *
 * Ce sont des trackers francophones : on n'y publie pas une release sans francais.
 * L'information vient de l'operateur, elle ne se deduit d'aucune donnee — et c'est
 * precisement ce qui la rend utile : elle transforme une declaration lue dans le titre
 * (« VOSTFR » ecrit par l'uploadeur) en fait tenant a la provenance.
 *
 * DigitalCore et DarkPeers en sont volontairement EXCLUS : ce sont des trackers
 * internationaux, ou l'absence de marqueur ne dit rien. Pour eux, seule la preuve
 * compte — pistes lues ou MediaInfo publie.
 */
const TRACKERS_FRANCAIS = new Set(['c411', 'tr4ker', 'yggreborn', 'g3mini']);

/**
 * Trackers PRIVES : leurs torrents n'ont d'annonceur que dans le fichier `.torrent`.
 *
 * Un hash nu n'en porte aucun. Depose seul chez un debrideur, il ne trouvera jamais de
 * pair et ne se telechargera pas — c'est le « ghost leech » : rien ne bouge, et le
 * tracker ne voit rien passer, donc le ratio n'est pas entame non plus.
 *
 * Consequence pratique : quand l'utilisateur refuse d'envoyer le `.torrent` (qui
 * contient sa passkey), une entree privee PAS DEJA EN CACHE est une impasse. La lui
 * proposer, c'est lui promettre une lecture que ses propres reglages interdisent.
 */
const TRACKERS_PRIVES = new Set(['c411', 'tr4ker', 'yggreborn', 'g3mini', 'dpeers', 'dcore']);

export function porteDuFrancais(c: Candidate): boolean {
  // 0. L'ORIGINE, quand elle suffit a conclure. Placee avant l'etiquette : une release
  //    d'un tracker francophone dont le titre ne porte aucun marqueur reste francaise,
  //    et l'analyse du nom n'aurait rien trouve.
  if (TRACKERS_FRANCAIS.has(c.sourceId)) return true;

  // 1. Les pistes enumerees par la source : on SAIT.
  if (c.subs?.some((t) => t.lang === 'fre')) return true;

  // 2. Le MediaInfo publie par le tracker : on SAIT AUSSI, et cette certitude prime
  //    sur l'etiquette du titre — dans les deux sens. Une release muette sur sa langue
  //    qui porte du francais passe ; un « Multi Subs » qui n'en a pas est ecarte,
  //    quoi qu'annonce son nom.
  if (c.languesIntegrees) return c.languesIntegrees.includes('fre');

  // 3. Faute de mieux, l'etiquette. C'est une declaration, pas une preuve.
  return ['VOSTFR', 'VF', 'MULTI'].includes(normalizeLanguage(c.language));
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

/**
 * Ordre entre sources DIRECTES, a pilier egal.
 *
 * KissKH d'abord : c'est la source la mieux dotee en sous-titres — souvent six pistes
 * dont le francais — et elle sert le flux sans intermediaire. Les sources absentes de
 * cette table passent apres celles qui y figurent, sans etre penalisees entre elles.
 */
const RANG_DIRECT: Record<string, number> = { kisskh: 0, voirdrama: 1 };

function rangSourceDirecte(c: Candidate): number {
  if (c.kind !== 'direct') return 0;
  return RANG_DIRECT[c.sourceId] ?? 50;
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
  // UNE PRIORITE DE PILIER EXPLICITE PASSE AVANT TOUT.
  //
  // Elle etait evaluee apres l'etat de pret, ce qui la rendait inoperante des que la
  // liste melangeait du pret et du non-pret : quelqu'un qui demande « Torrent d'abord »
  // recevait quand meme les flux directs en tete. Une consigne posee a la main par
  // l'utilisateur ne doit pas se faire arbitrer par une heuristique maison.
  const parPilier = rangPriorite(a.candidate, o.priorite) - rangPriorite(b.candidate, o.priorite);
  if (parPilier !== 0) return parPilier;

  // UN FLUX DIRECT EST PRET, au meme titre qu'un fichier deja en cache : il ne
  // traverse aucun debrideur, rien n'est a telecharger. Le compter comme « pas pret »
  // contredisait le filtre « uniquement ce qui est pret », qui le laisse passer, et
  // l'etiquette `[▶ ⚡]` que l'addon lui affiche.
  const pret = (e: EtatFlux): number => (e.cached === true || e.candidate.kind === 'direct' ? 0 : 1);
  const parPret = pret(a) - pret(b);
  if (parPret !== 0) return parPret;

  // Entre deux flux directs, l'ordre des sources tranche avant le critere de tri :
  // sinon KissKH et VoirDrama s'echangent la tete au gre de la qualite annoncee.
  const parSourceDirecte = rangSourceDirecte(a.candidate) - rangSourceDirecte(b.candidate);
  if (parSourceDirecte !== 0) return parSourceDirecte;

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
