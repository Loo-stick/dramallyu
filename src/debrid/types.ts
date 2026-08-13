// Contrat commun des debrideurs.
//
// Les deux services rendent le meme service final — un lien HTTP jouable — mais leurs
// modeles different assez pour que l'interface le reconnaisse honnetement :
//
//  - TorBox expose un check-cache par LOT : on peut dire « instantane » sans mentir.
//  - AllDebrid n'a plus d'API d'instant-availability fiable. On n'invente donc pas de
//    badge : `checkCached` y rend une carte vide, et l'interface affiche « a debrider ».
//
// C'est un choix delibere : afficher un faux « instantane » se paie en confiance
// perdue au premier clic.

export interface DebridFile {
  name: string;
  sizeBytes?: number;
  /** Identifiant du fichier chez le debrideur (TorBox) ou lien direct (AllDebrid). */
  id?: string | number;
  link?: string;
}

export interface DebridService {
  name: 'alldebrid' | 'torbox';
  /** Vrai si le service sait repondre honnetement sur la mise en cache. */
  supportsCacheCheck: boolean;
  /** hash minuscule -> present en cache. Carte vide = « on ne sait pas ». */
  checkCached(hashes: string[], signal?: AbortSignal): Promise<Map<string, boolean>>;
  /** Magnet ou hash -> lien HTTP jouable. */
  /**
   * `torrentUrl` est le lien vers le .torrent, quand la source en fournit un. Il est
   * indispensable sur les trackers PRIVES : un hash nu n'y donne acces a rien, faute
   * d'annonceur et de metadonnees.
   */
  resolveTorrent(
    magnetOrHash: string,
    fileHint?: string,
    signal?: AbortSignal,
    torrentUrl?: string,
  ): Promise<string | null>;
  /** Lien d'hebergeur (1fichier, uptobox...) -> lien HTTP jouable. */
  resolveDdl(link: string, signal?: AbortSignal): Promise<string | null>;
  /** Fichiers d'un torrent resolu — sert a recuperer les .srt livres avec la release. */
  listFiles(magnetOrHash: string, signal?: AbortSignal): Promise<DebridFile[]>;
}

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts)$/i;
// Les releases embarquent des echantillons et des bandes-annonces : les servir a la
// place du film est un grand classique des addons mal ecrits.
const JUNK = /(^|[\W_])(sample|trailer|extras?|bonus|featurette)([\W_]|$)/i;

export function isVideoFile(name: string): boolean {
  return VIDEO_EXT.test(name) && !JUNK.test(name);
}

export function isSubtitleFile(name: string): boolean {
  return /\.(srt|ass|ssa|vtt|sub)$/i.test(name);
}

/**
 * Choisit le fichier a lire dans un torrent multi-fichiers.
 *
 * `hint` porte le motif attendu (« S01E03 », « 1x03 »...). Sans indication exploitable
 * on prend la plus grosse video : sur une release d'episode unique c'est le bon choix,
 * et sur un pack ca evite au moins de servir un echantillon de 30 Mo.
 */
export function pickFile(files: DebridFile[], hint?: string): DebridFile | null {
  const videos = files.filter((f) => isVideoFile(f.name));
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];

  if (hint) {
    const trouve = chercherEpisode(videos, hint);
    // ON NE SERT PAS UN AUTRE EPISODE.
    //
    // Le repli « le plus gros fichier » etait applique meme quand on cherchait un
    // episode precis : demander S01E05 dans un pack qui ne l'a pas rendait S01E01,
    // silencieusement. L'utilisateur lance sa lecture et tombe sur le mauvais
    // episode — pire que de ne rien recevoir, puisqu'il ne comprend pas pourquoi.
    // Le repli n'a de sens que sans indication : la, le plus gros fichier est bien
    // le film ou l'episode, et ca evite de servir un echantillon de 30 Mo.
    return trouve;
  }

  return videos.reduce((best, f) => ((f.sizeBytes ?? 0) > (best.sizeBytes ?? 0) ? f : best));
}

/**
 * Retrouve un episode dans un dossier, quelle que soit la convention de nommage.
 *
 * Les teams ne nomment pas toutes pareil : « S01E05 », « 1x05 », « - 05 », « EP05 ».
 * S'en tenir a la seule forme SxxEyy ferait rejeter des packs parfaitement valides,
 * et on retomberait alors sur « rien » la ou le fichier existe.
 */
function chercherEpisode(videos: DebridFile[], hint: string): DebridFile | null {
  const m = hint.match(/^s(\d{2})e(\d{2})$/i);
  if (!m) {
    const needle = hint.toLowerCase();
    return videos.find((f) => f.name.toLowerCase().includes(needle)) ?? null;
  }

  const saison = Number(m[1]);
  const episode = Number(m[2]);
  const e = String(episode).padStart(2, '0');
  const s = String(saison).padStart(2, '0');

  const motifs = [
    new RegExp(`s${s}[\\s._-]*e${e}\\b`, 'i'),
    new RegExp(`\\b${saison}x${e}\\b`, 'i'),
    new RegExp(`\\bep?[\\s._-]*${e}\\b`, 'i'),
    new RegExp(`\\bepisode[\\s._-]*${episode}\\b`, 'i'),
    // Dernier recours : un nombre isole, entoure de separateurs. Volontairement le
    // plus permissif, donc essaye en dernier — « - 05. » dans « Drama - 05.mkv ».
    new RegExp(`[\\s._-]${e}[\\s._-]`, 'i'),
  ];

  for (const motif of motifs) {
    const trouve = videos.find((f) => motif.test(nomSeul(f.name)));
    if (trouve) return trouve;
  }
  return null;
}

/** Nom de fichier sans son chemin : le dossier porte souvent « S01 », qui trompe. */
function nomSeul(chemin: string): string {
  return chemin.split('/').pop() || chemin;
}

/** Motif d'episode utilisable comme indice de fichier : « S01E03 ». */
export function episodeHint(season?: number, episode?: number): string | undefined {
  if (!season || !episode) return undefined;
  return `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`;
}

/** Hash nu depuis un magnet ou un hash deja nu. */
export function extractHash(magnetOrHash: string): string | null {
  const direct = magnetOrHash.trim().toLowerCase();
  if (/^[a-f0-9]{40}$/.test(direct)) return direct;
  const m = direct.match(/btih:([a-f0-9]{40})/i);
  return m ? m[1].toLowerCase() : null;
}

export function toMagnet(magnetOrHash: string): string {
  if (magnetOrHash.startsWith('magnet:')) return magnetOrHash;
  const hash = extractHash(magnetOrHash);
  return hash ? `magnet:?xt=urn:btih:${hash}` : magnetOrHash;
}
