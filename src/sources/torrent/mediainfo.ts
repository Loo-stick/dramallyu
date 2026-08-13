// Langues des sous-titres INTEGRES, lues dans le MediaInfo publie par le tracker.
//
// Le nom d'une release ment dans les deux sens, et les deux cas ont ete constates en
// production sur le meme drama :
//
//   « Pursuit of Jade ... Tsundere-Raws (Multi Subs, Multi Audio) »  -> chinois, anglais
//   « Pursuit of Jade AKA Zhu yu S01 1080p iQIYI WEB-DL H.264-ANDY » -> contient du FR
//
// Le premier promet une langue qu'il n'a pas, le second cache celle qu'on cherche.
// Filtrer ou classer sur le titre est donc perdu d'avance.
//
// Les trackers UNIT3D publient le MediaInfo complet dans leur reponse de RECHERCHE.
// L'information arrive donc gratuitement, dans un appel qu'on fait deja : ni fichier a
// telecharger, ni resolution chez le debrideur, ni requete de plus.

/** Noms de langue tels que MediaInfo les ecrit, vers l'ISO 639-2. */
const NOMS_VERS_CODE: Record<string, string> = {
  french: 'fre',
  english: 'eng',
  korean: 'kor',
  japanese: 'jpn',
  chinese: 'chi',
  mandarin: 'chi',
  cantonese: 'chi',
  thai: 'tha',
  arabic: 'ara',
  spanish: 'spa',
  portuguese: 'por',
  german: 'ger',
  italian: 'ita',
  russian: 'rus',
  indonesian: 'ind',
  vietnamese: 'vie',
  malay: 'may',
  turkish: 'tur',
  dutch: 'dut',
  polish: 'pol',
  hebrew: 'heb',
  greek: 'gre',
  czech: 'cze',
  danish: 'dan',
  swedish: 'swe',
  finnish: 'fin',
  norwegian: 'nor',
  hungarian: 'hun',
  romanian: 'rum',
  croatian: 'hrv',
  catalan: 'cat',
  basque: 'baq',
  galician: 'glg',
  filipino: 'fil',
  hindi: 'hin',
  ukrainian: 'ukr',
};

/**
 * Code ISO 639-2 d'un libelle MediaInfo, ou null.
 *
 * Les qualificatifs entre parentheses sont retires : « Chinese (Traditional) » et
 * « Spanish (Latin America) » designent la meme langue que leur forme nue, et les
 * distinguer multiplierait les entrees sans rien apporter a la question posee — cette
 * release porte-t-elle ma langue ?
 */
export function codeDeLangue(libelle: string): string | null {
  const nu = libelle.split('(')[0].trim().toLowerCase();
  if (!nu) return null;
  return NOMS_VERS_CODE[nu] ?? null;
}

/**
 * Langues des pistes de SOUS-TITRES declarees par le MediaInfo.
 *
 * On suit les sections : « General », « Video », « Audio », « Text #n », « Menu ». Ne
 * comptent que les sections Text — confondre avec l'audio annoncerait du francais sur
 * une release doublee sans sous-titres, ou l'inverse, et c'est precisement la
 * confusion qu'on cherche a lever.
 */
export function languesSousTitres(mediaInfo: string): string[] {
  if (!mediaInfo) return [];
  const out = new Set<string>();
  let dansTexte = false;

  for (const ligne of mediaInfo.split(/\r?\n/)) {
    const entete = ligne.match(/^(General|Video|Audio|Text|Menu)\b/i);
    if (entete) {
      dansTexte = entete[1].toLowerCase() === 'text';
      continue;
    }
    if (!dansTexte) continue;

    const langue = ligne.match(/^\s*Language\s*:\s*(.+?)\s*$/i);
    if (langue) {
      const code = codeDeLangue(langue[1]);
      if (code) out.add(code);
    }
  }

  return [...out];
}
