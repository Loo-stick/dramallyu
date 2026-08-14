// Lecture d'un nom de release.
//
// Les trackers ne donnent qu'une chaine : « Squid.Game.S01E09.MULTi.1080p.WEB-DL.x264 ».
// Tout ce qu'on sait d'un torrent (qualite, langue, episode, pack ou non) se lit la.
// Ce fichier est pur et entierement teste : c'est la brique la plus rejouee du projet,
// et une erreur ici sert le mauvais episode a l'utilisateur.

export interface ParsedRelease {
  quality: string;
  language: string;
  season: number | null;
  episode: number | null;
  /** Vrai si la release couvre une saison entiere plutot qu'un episode. */
  isPack: boolean;
  /**
   * Numero d'episode ABSOLU, compte depuis le debut de la serie.
   *
   * Renseigne seulement quand la release en porte un ET qu'aucune saison n'est
   * annoncee — le cas des donghua et des raws asiatiques (« ... - 156 »). Sert a
   * faire correspondre une demande S02E01 a une release numerotee 13, ce qui etait
   * simplement impossible avant.
   */
  absolu?: number | null;
}

import { structureDe } from './structure';

export function qualityOf(name: string): string {
  const n = name.toLowerCase();
  if (/(2160p|4k|uhd)/.test(n)) return '4K';
  if (/1080p/.test(n)) return '1080p';
  if (/720p/.test(n)) return '720p';
  if (/576p/.test(n)) return '576p';
  if (/480p/.test(n)) return '480p';
  if (/360p/.test(n)) return '360p';
  return 'HD';
}

/**
 * Langue d'une release.
 *
 * Ordre volontaire : MULTI avant VF, car « MULTi » implique la presence du francais
 * ET de la piste originale — c'est mieux qu'une VF seule pour un public de dramas,
 * qui veut souvent la VO. VOSTFR avant VF pour la meme raison.
 */
export function languageOf(name: string): string {
  const n = name.toLowerCase();

  // « MULTI » NE VEUT PAS DIRE LA MEME CHOSE PARTOUT.
  //
  // Dans la scene francaise, le jeton « MULTi » seul signifie « plusieurs pistes dont
  // le francais » — c'est une convention etablie. Mais « Multi Subs » et
  // « Multi Audio » sont de simples descriptions anglaises, employees par les groupes
  // de raws asiatiques pour dire « chinois + anglais ».
  //
  // Constate en production : « Pursuit of Jade S01 ... x264-Tsundere-Raws (Multi Subs,
  // Multi Audio) » etait annonce MULTI. L'utilisateur choisit ce flux pour son
  // francais, lance la lecture, et decouvre 13 pistes integrees en chinois et anglais.
  // Promettre une langue absente est la pire erreur que ce fichier puisse commettre.
  //
  // On retire donc ces tournures AVANT de chercher le jeton « multi » : ce qui reste
  // est la convention de scene, pas une description.
  const sansDescription = n.replace(/\bmulti[\s._-]?(subs?|audios?|sub|lang(uages?)?)\b/g, ' ');
  if (/\bmulti\b/.test(sansDescription)) return 'MULTI';
  if (/\bvostfr\b|\bvost\b/.test(n)) return 'VOSTFR';
  // AVANT le test VF, et c'est capital : « french sub » contient « french ». Teste
  // dans l'autre ordre, une release sous-titree serait annoncee comme doublee — et
  // l'utilisateur decouvre le mensonge en lançant la lecture.
  if (/\bfre?nch[\s._-]?sub/.test(n) || /\bsub[\s._-]?fr(e|ench)?\b/.test(n) || /\[fr\]/.test(n)) {
    return 'VOSTFR';
  }
  if (/\btruefrench\b|\bvff\b|\bvfq\b|\bvf\b|\bfrench\b/.test(n)) return 'VF';
  return 'VO';
}

/** Saison et episode, dans les nombreuses graphies qui circulent. */
export function seasonEpisodeOf(name: string): { season: number | null; episode: number | null } {
  const n = name.replace(/_/g, ' ');

  const sxxexx = n.match(/\bs(\d{1,2})[\s._-]*e(\d{1,3})\b/i);
  if (sxxexx) return { season: Number(sxxexx[1]), episode: Number(sxxexx[2]) };

  const cross = n.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (cross) return { season: Number(cross[1]), episode: Number(cross[2]) };

  const verbose = n.match(/\bsais?on[\s._-]*(\d{1,2}).*?\bepisode[\s._-]*(\d{1,3})\b/i);
  if (verbose) return { season: Number(verbose[1]), episode: Number(verbose[2]) };

  const seasonOnly = n.match(/\bs(?:ais)?o?n?[\s._-]*(\d{1,2})\b/i);
  const episodeOnly = n.match(/\b(?:episode|ep|e)[\s._-]*(\d{1,3})\b/i);
  if (episodeOnly) {
    return {
      season: seasonOnly ? Number(seasonOnly[1]) : null,
      episode: Number(episodeOnly[1]),
    };
  }

  // Dernier recours, indispensable pour Nyaa : les teams de fansub nomment
  // « [TeamFR] Squid Game - 09 [1080p].mkv », sans aucun marqueur d'episode. Sans
  // cette lecture, on rejetterait la quasi-totalite de la source.
  //
  // Les garde-fous comptent autant que le motif : on exige un tiret entoure d'espaces
  // (pour ne pas confondre avec « WEB-DL »), et on refuse un nombre suivi de « p »
  // (1080p) ou long de quatre chiffres (une annee).
  const bare = n.match(/\s-\s*0*(\d{1,3})(?![\dp])(?:\s|$|\[|\()/i);
  if (bare) {
    return { season: seasonOnly ? Number(seasonOnly[1]) : null, episode: Number(bare[1]) };
  }

  return { season: seasonOnly ? Number(seasonOnly[1]) : null, episode: null };
}

/**
 * Pack de saison ? Un pack reste utile : le debrideur y choisira le bon fichier grace
 * a l'indice d'episode. Les jeter reviendrait a perdre une grande partie de l'offre,
 * les dramas circulant beaucoup en saisons completes.
 */
export function isPackRelease(name: string, episode: number | null): boolean {
  if (episode !== null) return false;
  return /\b(complete|integrale|int[ée]grale|saison|season|pack|s\d{1,2})\b/i.test(name);
}

/**
 * Details techniques lus dans un nom de release, pour l'affichage.
 *
 * Chaque champ vaut null quand on ne sait pas — et c'est important : la ligne
 * affichee omet alors le segment plutot que d'ecrire « inconnu ». Une ligne courte
 * mais vraie vaut mieux qu'une ligne remplie de trous.
 */
export interface ReleaseDetails {
  /** BluRay, REMUX, WEB-DL, WEBRip, HDTV, DVDRip... */
  source: string | null;
  /** HDR10, Dolby Vision, HDR. */
  hdr: string | null;
  /** HEVC, AVC, AV1, XviD. */
  video: string | null;
  /** TrueHD Atmos, DTS-HD, EAC3, AC3, AAC, FLAC... */
  audio: string | null;
  /** Team de release : le suffixe -GROUPE. */
  team: string | null;
}

function premier(nom: string, table: [RegExp, string][]): string | null {
  for (const [motif, libelle] of table) if (motif.test(nom)) return libelle;
  return null;
}

const SOURCES: [RegExp, string][] = [
  [/\bremux\b/i, 'REMUX'],
  [/\b(bluray|blu-ray|bdrip|brrip)\b/i, 'BluRay'],
  [/\bweb[-. ]?dl\b/i, 'WEB-DL'],
  [/\bweb[-. ]?rip\b/i, 'WEBRip'],
  [/\bhdtv\b/i, 'HDTV'],
  [/\b(dvdrip|dvd)\b/i, 'DVDRip'],
  [/\bhdlight\b/i, 'HDLight'],
  [/\bweb\b/i, 'WEB'],
];

const HDR: [RegExp, string][] = [
  [/\bdv\b|\bdolby[-. ]?vision\b/i, 'Dolby Vision'],
  [/\bhdr10\+/i, 'HDR10+'],
  [/\bhdr10\b/i, 'HDR10'],
  [/\bhdr\b/i, 'HDR'],
];

const VIDEO: [RegExp, string][] = [
  [/\b(hevc|x265|h\.?265)\b/i, 'HEVC'],
  [/\bav1\b/i, 'AV1'],
  [/\b(avc|x264|h\.?264)\b/i, 'AVC'],
  [/\bxvid\b/i, 'XviD'],
];

const AUDIO: [RegExp, string][] = [
  [/\btruehd\b.*\batmos\b|\batmos\b.*\btruehd\b/i, 'TrueHD Atmos'],
  [/\btruehd\b/i, 'TrueHD'],
  [/\bdts[-. ]?hd\b/i, 'DTS-HD'],
  [/\bdts\b/i, 'DTS'],
  [/\batmos\b/i, 'Atmos'],
  [/\b(eac3|e-ac3|ddp|dd\+)\b/i, 'EAC3'],
  [/\b(ac3|dd5)\b/i, 'AC3'],
  [/\bflac\b/i, 'FLAC'],
  [/\baac\b/i, 'AAC'],
  [/\bopus\b/i, 'Opus'],
];

/** Team de release : le suffixe apres le dernier tiret, hors extension. */
export function teamOf(name: string): string | null {
  const sansExt = name.replace(/\.(mkv|mp4|avi|ts)$/i, '');
  const m = sansExt.match(/-([A-Za-z0-9]{2,20})$/);
  if (!m) return null;
  const candidat = m[1];
  // Un suffixe purement numerique est un numero d'episode, pas une team.
  if (/^\d+$/.test(candidat)) return null;
  return candidat;
}

export function releaseDetails(name: string): ReleaseDetails {
  return {
    source: premier(name, SOURCES),
    hdr: premier(name, HDR),
    video: premier(name, VIDEO),
    audio: premier(name, AUDIO),
    team: teamOf(name),
  };
}

export function parseRelease(name: string): ParsedRelease {
  const nous = seasonEpisodeOf(name);
  // La structure vient de `structure.ts` quand il la connait, de nos expressions
  // regulieres sinon. Le partage n'est pas arbitraire : mesure sur 122 titres reels,
  // il a eu raison dix fois sur dix la ou nous divergions — toujours sur la forme
  // francaise « Saison 1 Épisode 4 », que nous lisions comme un PACK faute d'y voir
  // l'episode. La langue, elle, ne lui est jamais confiee (cf. structure.ts).
  const lue = structureDe(name);

  const season = lue?.season ?? nous.season;
  const episode = lue?.episode ?? nous.episode;

  // Un numero n'est ABSOLU que si aucune saison n'est annoncee : « S02E13 » porte un
  // 13 qui appartient a sa saison, pas a la serie entiere.
  const absolu = lue && lue.absolu !== null && season === null ? lue.absolu : null;

  return {
    quality: qualityOf(name),
    language: languageOf(name),
    season,
    episode,
    // Notre detection reste en repli : elle reconnait « INTEGRALE » et « pack », que
    // la lecture structuree ne signale pas toujours.
    isPack: lue?.isPack || isPackRelease(name, episode),
    absolu,
  };
}

/**
 * Cette release repond-elle a la demande ?
 *
 * Regle : on accepte l'episode exact, ou un pack de la bonne saison. On refuse tout
 * ce qui annonce une AUTRE saison ou un AUTRE episode — servir le mauvais episode est
 * la pire chose qu'un addon de series puisse faire.
 */
export function matchesEpisode(
  parsed: ParsedRelease,
  season?: number,
  episode?: number,
  episodesParSaison?: Record<number, number>,
): boolean {
  if (season === undefined || episode === undefined) return true;

  if (parsed.season !== null && parsed.season !== season) return false;
  if (parsed.episode !== null) {
    if (parsed.episode === episode) return true;
    // NUMEROTATION ABSOLUE. Un donghua publie « - 156 » sans saison : ce 156 compte
    // depuis le debut de la serie. On ne pouvait pas le rapprocher d'une demande
    // S02E01, et ces releases etaient donc toutes rejetees. Avec le compte d'episodes
    // par saison — qu'on connait deja, il sert a juger les packs — la conversion est
    // exacte, et on ne l'applique QUE si elle l'est.
    if (parsed.absolu !== null && parsed.absolu !== undefined && episodesParSaison) {
      const attendu = absoluDe(season, episode, episodesParSaison);
      if (attendu !== null) return parsed.absolu === attendu;
    }
    return false;
  }
  // Pas d'episode annonce : recevable seulement si ca ressemble a un pack.
  return parsed.isPack || parsed.season === season;
}

/**
 * Numero absolu correspondant a un couple saison/episode.
 *
 * Rend `null` des qu'une saison anterieure manque au compte : mieux vaut ne pas
 * conclure que servir le mauvais episode, qui est la pire faute possible ici.
 */
export function absoluDe(
  season: number,
  episode: number,
  episodesParSaison: Record<number, number>,
): number | null {
  // L'episode demande doit exister dans sa saison. Sans ce controle, une demande
  // impossible comme S01E42 sur une saison de trente episodes se convertissait en
  // absolu 42 — et tombait pile sur une release qui appartient a la saison 2.
  const dansLaSaison = episodesParSaison[season];
  if (dansLaSaison !== undefined && episode > dansLaSaison) return null;

  let total = 0;
  for (let s = 1; s < season; s++) {
    const n = episodesParSaison[s];
    if (!n) return null;
    total += n;
  }
  return total + episode;
}
