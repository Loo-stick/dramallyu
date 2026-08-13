// Correspondance de titres.
//
// C'est LE point sensible d'un addon de dramas : les titres asiatiques circulent en
// plusieurs romanisations ("Squid Game" / "Ojingeo geim" / "Round Six"), avec des
// suffixes de saison heterogenes ("Season 2", "S2", "Class 1"), et une correspondance
// approximative sert le mauvais episode a l'utilisateur — ce qui est pire que de ne
// rien servir.
//
// Politique : la PRECISION avant le rappel. On prefere rendre zero resultat plutot
// qu'un mauvais.

const STOP_WORDS = new Set(['the', 'a', 'an', 'le', 'la', 'les', 'un', 'une', 'de', 'des', 'du']);

/**
 * Ecritures CONSERVEES par la tokenisation, en plus du latin.
 *
 * Les effacer serait absurde dans un addon de dramas asiatiques : c'est justement la
 * forme sous laquelle les titres originaux circulent. Un jeu de caracteres non retenu
 * ici ne disparait pas seulement, il DEGENERE — « 성판17: 남자들의 17가지 성적 판타지 »
 * se reduisait a « 1717 », un residu de chiffres qui matche n'importe quel titre
 * contenant « 17 ». C'est ce qui faisait choisir « 17 Again » a la place de
 * « Sex Plate 17 », et la clé TMDB de l'utilisateur — censee aider — declenchait le
 * defaut en fournissant le titre coreen.
 */
const ECRITURES =
  'a-z0-9' +
  '\\uac00-\\ud7af\\u1100-\\u11ff\\u3130-\\u318f' + // hangul (coreen)
  '\\u4e00-\\u9fff\\u3400-\\u4dbf' + //               han (chinois, kanji)
  '\\u3040-\\u309f\\u30a0-\\u30ff' + //               kana (japonais)
  '\\u0e00-\\u0e7f'; //                               thai

const NON_RETENU = new RegExp(`[^${ECRITURES}]+`, 'g');

/** "Squid Game: Season 2 (2024)" -> ["squid","game"] */
export function tokenize(title: string): string[] {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(season|saison|s)\s*\d+\b/g, ' ')
    .replace(/\b(vf|vostfr|vost|vo|multi|french|truefrench)\b/g, ' ')
    .replace(NON_RETENU, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/**
 * Cette forme de titre discrimine-t-elle quelque chose ?
 *
 * Un titre dont il ne reste que des chiffres ne designe plus une oeuvre : il matche
 * tout ce qui porte le meme nombre. C'est le filet pour les ecritures qu'on ne retient
 * pas ci-dessus (cyrillique, arabe, hebreu...) — elles degenerent de la meme façon, et
 * une forme sans pouvoir de discrimination doit sortir du jeu plutot que d'y voter.
 */
export function titreDiscriminant(title: string): boolean {
  return tokenize(title).some((t) => !/^\d+$/.test(t));
}

/**
 * Ecarte les formes degenerees, SAUF s'il ne reste plus rien.
 *
 * Le repli n'est pas une concession : sans lui, une oeuvre dont tous les titres connus
 * sont degeneres deviendrait introuvable, alors qu'un match faible reste preferable a
 * l'absence de recherche quand on n'a rien de mieux.
 */
export function formesUtiles(titles: string[]): string[] {
  const utiles = titles.filter(titreDiscriminant);
  return utiles.length > 0 ? utiles : titles;
}

/** Forme compacte, sans espaces : utile pour les comparaisons strictes. */
export function normalizeTitle(title: string): string {
  return tokenize(title).join('');
}

/**
 * Similarite par ensemble de jetons (Jaccard pondere par la couverture du plus court).
 * 1 = identique, 0 = disjoint.
 */
export function tokenSetScore(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  // On divise par le PLUS PETIT ensemble : "Squid Game" doit matcher fortement
  // "Squid Game Season 1", dont le titre porte des jetons en plus.
  return common / Math.min(ta.size, tb.size);
}

/** Numero de saison porte par un titre, quand il y en a un. */
export function seasonInTitle(title: string): number | null {
  const hay = title.toLowerCase();
  const m =
    hay.match(/\bsais?on\s*0*(\d{1,2})\b/) ||
    hay.match(/\bseason\s*0*(\d{1,2})\b/) ||
    hay.match(/\bs(\d{1,2})\b/) ||
    // Certains dramas encodent la saison autrement : « Weak Hero Class 1 / Class 2 ».
    hay.match(/\bclass\s*0*(\d{1,2})\b/);
  return m ? Number(m[1]) : null;
}

/** Annee portee par un titre ou une release. */
export function yearInTitle(title: string): number | null {
  const m = title.match(/\b(19|20)(\d{2})\b/);
  return m ? Number(m[0]) : null;
}

export interface MatchOptions {
  /** Score minimal accepte. Au-dessous, on considere que ce n'est pas la meme oeuvre. */
  threshold?: number;
  /** Saison attendue. Si le candidat en annonce une differente, il est rejete. */
  season?: number;
  /** Annee attendue. Un ecart de plus d'un an disqualifie. */
  year?: number;
}

const DEFAULT_THRESHOLD = 0.75;

/**
 * Le candidat correspond-il a l'une des formes connues du titre ?
 *
 * `titles` contient le titre original, le titre FR, et les alternatifs : il suffit
 * qu'UNE forme corresponde. C'est ce qui rattrape les romanisations.
 */
export function matchesTitle(candidate: string, titres: string[], opts: MatchOptions = {}): boolean {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  // Une forme degeneree ne doit pas peser dans le vote : elle dirait « oui » a tout.
  const titles = formesUtiles(titres);

  if (opts.season !== undefined) {
    const s = seasonInTitle(candidate);
    // Un candidat SANS saison annoncee reste recevable (la saison 1 ne s'ecrit
    // presque jamais). Un candidat qui en annonce une AUTRE est rejete sans appel.
    if (s !== null && s !== opts.season) return false;
  }

  if (opts.year !== undefined) {
    const y = yearInTitle(candidate);
    if (y !== null && Math.abs(y - opts.year) > 1) return false;
  }

  return titles.some((t) => t && tokenSetScore(candidate, t) >= threshold);
}

/** Meilleur candidat d'une liste, ou null si aucun ne franchit le seuil. */
export function bestMatch<T>(
  items: T[],
  titleOf: (item: T) => string,
  titres: string[],
  opts: MatchOptions = {},
): T | null {
  // Meme raison que dans matchesTitle : on note sur les formes qui discriminent.
  const titles = formesUtiles(titres);
  let best: T | null = null;
  let bestScore = opts.threshold ?? DEFAULT_THRESHOLD;

  for (const item of items) {
    const name = titleOf(item);
    if (!matchesTitle(name, titles, opts)) continue;
    const score = Math.max(...titles.map((t) => tokenSetScore(name, t)));
    if (score >= bestScore) {
      // A score egal, on prefere le titre le plus court : il porte moins de mentions
      // parasites (« Squid Game » plutot que « Squid Game Special Edition »).
      if (score > bestScore || (best && normalizeTitle(name).length < normalizeTitle(titleOf(best)).length)) {
        best = item;
        bestScore = score;
      } else if (!best) {
        best = item;
        bestScore = score;
      }
    }
  }
  return best;
}

/**
 * Confirmation par l'image TMDB (niveau 2, quand l'utilisateur a une cle TMDB).
 *
 * Les vignettes KissKH sont des chemins TMDB bruts :
 *   https://media.themoviedb.org/t/p/w1000_and_h563_face/vOgGdN0vBOnhtjbe3i86SQRdQA1.jpg
 * Le nom de fichier EST l'identifiant d'image TMDB. Une egalite exacte avec une image
 * de la fiche TMDB candidate n'est donc pas une heuristique : c'est une preuve.
 */
export function tmdbImagePath(url: string): string | null {
  if (!url) return null;
  const m = url.match(/\/([A-Za-z0-9]{20,}\.(?:jpg|png|webp))(?:$|\?)/);
  return m ? `/${m[1]}` : null;
}

/** Le chemin d'image de la vignette figure-t-il dans les images de la fiche TMDB ? */
export function confirmByTmdbImage(thumbnailUrl: string, tmdbImagePaths: string[]): boolean {
  const path = tmdbImagePath(thumbnailUrl);
  if (!path) return false;
  return tmdbImagePaths.includes(path);
}
