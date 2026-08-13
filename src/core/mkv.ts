// Pistes declarees dans l'en-tete d'un fichier Matroska.
//
// La seule verite sur les sous-titres d'une release est le fichier lui-meme. Son nom
// ment dans les deux sens — constate sur le meme drama : un « (Multi Subs, Multi
// Audio) » qui ne porte que du chinois et de l'anglais, et un « ...H.264-ANDY », muet
// sur sa langue, qui contient bel et bien du francais.
//
// Et l'information est bon marche : Matroska declare TOUTES ses pistes dans un en-tete
// place avant la premiere image. Mesure faite sur des fichiers reels, 32 Ko suffisent.
//
// ON PARCOURT REELLEMENT L'ARBRE EBML. Une premiere version cherchait les identifiants
// de codec puis la declaration de langue la plus proche : elle attribuait a une piste
// de sous-titres la langue d'une piste audio voisine. Sur une promesse aussi centrale
// que « ce fichier contient du francais », l'a-peu-pres ne suffit pas.

const ID_SEGMENT = 0x18538067;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC = 0x86;
const ID_LANGUE = 0x22b59c;
const ID_LANGUE_BCP47 = 0x22b59d;

/** Valeur de TrackType pour une piste de sous-titres. */
const TYPE_SOUS_TITRE = 0x11;

interface Element {
  id: number;
  /** Debut des donnees. */
  debut: number;
  /** Fin des donnees (exclue). Bornee au tampon disponible. */
  fin: number;
  /** Position du prochain element frere. */
  suivant: number;
}

/**
 * Lit un identifiant EBML.
 *
 * Sa longueur est donnee par les bits de tete du premier octet, et — contrairement aux
 * tailles — les bits marqueurs FONT PARTIE de la valeur : c'est ainsi que les
 * identifiants sont ecrits dans les specifications.
 */
function lireId(buf: Buffer, at: number): { valeur: number; apres: number } | null {
  const premier = buf[at];
  if (premier === undefined || premier === 0) return null;
  let longueur = 1;
  if (premier & 0x80) longueur = 1;
  else if (premier & 0x40) longueur = 2;
  else if (premier & 0x20) longueur = 3;
  else if (premier & 0x10) longueur = 4;
  else return null;

  if (at + longueur > buf.length) return null;
  let valeur = 0;
  for (let i = 0; i < longueur; i++) valeur = valeur * 256 + buf[at + i];
  return { valeur, apres: at + longueur };
}

/**
 * Lit une taille EBML. Les bits marqueurs sont retires de la valeur.
 *
 * Une taille dont tous les bits utiles valent 1 signifie « inconnue » : les fichiers
 * produits en flux l'emploient pour le Segment, dont la longueur n'etait pas connue a
 * l'ecriture. On la traite comme « jusqu'a la fin de ce qu'on a ».
 */
function lireTaille(buf: Buffer, at: number): { valeur: number | null; apres: number } | null {
  const premier = buf[at];
  if (premier === undefined || premier === 0) return null;
  let longueur = 1;
  let masque = 0x80;
  while (longueur <= 8 && (premier & masque) === 0) {
    masque >>= 1;
    longueur++;
  }
  if (longueur > 8 || at + longueur > buf.length) return null;

  let valeur = premier & (masque - 1);
  let inconnue = valeur === masque - 1;
  for (let i = 1; i < longueur; i++) {
    valeur = valeur * 256 + buf[at + i];
    if (buf[at + i] !== 0xff) inconnue = false;
  }
  return { valeur: inconnue ? null : valeur, apres: at + longueur };
}

/** Element commencant a `at`, ou null si illisible. */
function lireElement(buf: Buffer, at: number, finParente: number): Element | null {
  const id = lireId(buf, at);
  if (!id) return null;
  const taille = lireTaille(buf, id.apres);
  if (!taille) return null;

  const fin = taille.valeur === null ? finParente : Math.min(taille.apres + taille.valeur, finParente);
  return {
    id: id.valeur,
    debut: taille.apres,
    fin,
    // Une taille inconnue ne permet pas de sauter l'element : on ne peut que descendre
    // dedans, ce que fait l'appelant pour Segment.
    suivant: taille.valeur === null ? taille.apres : Math.min(taille.apres + taille.valeur, finParente),
  };
}

/** Entier non signe porte par un element. */
function lireEntier(buf: Buffer, el: Element): number {
  let v = 0;
  for (let i = el.debut; i < el.fin && i < buf.length; i++) v = v * 256 + buf[i];
  return v;
}

/** Chaine ASCII portee par un element, sans son remplissage nul. */
function lireChaine(buf: Buffer, el: Element): string {
  return buf
    .toString('latin1', el.debut, Math.min(el.fin, buf.length))
    .replace(/\0+$/, '')
    .trim();
}

/** Premier enfant d'identifiant `cible`, en descendant si demande. */
function trouver(buf: Buffer, debut: number, fin: number, cible: number, descendreDans: number[] = []): Element | null {
  let at = debut;
  while (at < fin && at < buf.length) {
    const el = lireElement(buf, at, fin);
    if (!el || el.suivant <= at) return null;
    if (el.id === cible) return el;
    if (descendreDans.includes(el.id)) {
      const dedans = trouver(buf, el.debut, el.fin, cible, descendreDans);
      if (dedans) return dedans;
    }
    at = el.suivant;
  }
  return null;
}

export interface Piste {
  /** 1 = video, 2 = audio, 17 = sous-titres. */
  type: number;
  codec: string;
  /** ISO 639-2, tel que declare. « eng » par defaut, comme l'impose Matroska. */
  langue: string;
}

/** ISO 639-1 vers 639-2, pour les fichiers qui declarent en BCP-47. */
const DEUX_VERS_TROIS: Record<string, string> = {
  fr: 'fre', en: 'eng', ko: 'kor', ja: 'jpn', zh: 'chi', th: 'tha', es: 'spa',
  pt: 'por', de: 'ger', it: 'ita', ar: 'ara', ru: 'rus', id: 'ind', vi: 'vie',
  tr: 'tur', nl: 'dut', pl: 'pol', ms: 'may', he: 'heb', el: 'gre',
};

/** Ramene les formes equivalentes d'un meme code a une seule. */
export function normaliserLangue(code: string): string {
  const c = code.split(/[-_]/)[0].toLowerCase();
  if (c.length === 2) return DEUX_VERS_TROIS[c] ?? c;
  // Le francais, le chinois et l'allemand ont chacun deux codes ISO 639-2 —
  // bibliographique et terminologique — et les fichiers emploient les deux.
  if (c === 'fra') return 'fre';
  if (c === 'zho') return 'chi';
  if (c === 'deu') return 'ger';
  return c;
}

/** Ce tampon commence-t-il par un en-tete EBML ? */
export function estMatroska(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
}

/**
 * Pistes declarees dans l'en-tete, ou tableau vide si Tracks n'y est pas.
 *
 * Un tableau vide signifie « on n'a pas su lire », JAMAIS « ce fichier n'a pas de
 * pistes » : l'element Tracks peut se trouver au-dela de la fenetre telechargee sur
 * les fichiers dont l'en-tete est place en fin. L'appelant doit traiter les deux cas
 * differemment.
 */
export function pistes(buf: Buffer): Piste[] {
  if (!estMatroska(buf)) return [];

  const tracks = trouver(buf, 0, buf.length, ID_TRACKS, [ID_SEGMENT]);
  if (!tracks) return [];

  const out: Piste[] = [];
  let at = tracks.debut;
  while (at < tracks.fin && at < buf.length) {
    const entree = lireElement(buf, at, tracks.fin);
    if (!entree || entree.suivant <= at) break;

    if (entree.id === ID_TRACK_ENTRY) {
      let type = 0;
      let codec = '';
      let langue = '';
      let langueBcp = '';

      let dans = entree.debut;
      while (dans < entree.fin && dans < buf.length) {
        const champ = lireElement(buf, dans, entree.fin);
        if (!champ || champ.suivant <= dans) break;
        if (champ.id === ID_TRACK_TYPE) type = lireEntier(buf, champ);
        else if (champ.id === ID_CODEC) codec = lireChaine(buf, champ);
        else if (champ.id === ID_LANGUE) langue = lireChaine(buf, champ);
        else if (champ.id === ID_LANGUE_BCP47) langueBcp = lireChaine(buf, champ);
        dans = champ.suivant;
      }

      // Matroska impose « eng » quand aucune langue n'est declaree : les fichiers
      // anglophones n'ecrivent souvent rien. BCP-47 prime, c'est le champ recent.
      const brut = langueBcp || langue || 'eng';
      out.push({ type, codec, langue: normaliserLangue(brut) });
    }
    at = entree.suivant;
  }
  return out;
}

/** Langues des pistes de SOUS-TITRES uniquement. */
export function languesSousTitres(buf: Buffer): string[] {
  const st = pistes(buf).filter((p) => p.type === TYPE_SOUS_TITRE);
  return [...new Set(st.map((p) => p.langue))];
}
