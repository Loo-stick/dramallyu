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
}

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
  if (/\bmulti\b/.test(n)) return 'MULTI';
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

export function parseRelease(name: string): ParsedRelease {
  const { season, episode } = seasonEpisodeOf(name);
  return {
    quality: qualityOf(name),
    language: languageOf(name),
    season,
    episode,
    isPack: isPackRelease(name, episode),
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
): boolean {
  if (season === undefined || episode === undefined) return true;

  if (parsed.season !== null && parsed.season !== season) return false;
  if (parsed.episode !== null) return parsed.episode === episode;
  // Pas d'episode annonce : recevable seulement si ca ressemble a un pack.
  return parsed.isPack || parsed.season === season;
}
