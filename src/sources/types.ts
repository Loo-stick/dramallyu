// Le contrat unique des trois piliers.
//
// C'est la piece qui empeche ce projet de devenir le index.ts de 146 Ko de LooStream :
// une source directe (KissKH), un tracker (Nyaa) et un site DDL (Zone-Telechargement)
// n'ont rien en commun techniquement, mais ils repondent tous a la meme question —
// « pour cette oeuvre, qu'est-ce que tu as ? » — et rendent tous le meme type.
//
// Ajouter une source = un fichier qui exporte un objet Source. Rien d'autre a toucher.

import type { UserConfig } from '../core/config';
import type { Deadline } from '../core/http';

export type MediaType = 'movie' | 'series';

/** Ce que le pilier consomme. Chaque source prend ce qu'elle sait exploiter. */
export interface Query {
  type: MediaType;
  /** "tt1399964" si connu — les Torznab savent chercher par la. */
  imdbId?: string;
  /** Id TMDB si connu — c'est le plus fiable pour les titres asiatiques. */
  tmdbId?: string;
  /** Id KissKH si la demande vient de notre propre catalogue. */
  kkhId?: string;
  /** Titres connus, du plus fiable au moins fiable (original, FR, alternatifs). */
  titles: string[];
  year?: number;
  season?: number;
  episode?: number;
  /** Langue d'origine ISO 639-1 ("ko", "zh", "ja", "th") si connue. */
  originalLanguage?: string;
}

export type SourceKind = 'direct' | 'torrent' | 'ddl';

export interface SubTrack {
  /** URL d'origine du sous-titre. Elle sera re-servie par nos propres endpoints. */
  url: string;
  /** ISO 639-2 (fre, eng, kor...) — ce que Stremio et Nuvio attendent. */
  lang: string;
  label: string;
}

/**
 * Un resultat de source, AVANT resolution. Aucune source ne debride ni ne resout :
 * elle decrit ce qu'elle a trouve, la resolution arrive au moment du Play.
 */
export interface Candidate {
  sourceId: string;
  kind: SourceKind;
  /** Nom de release (torrent/DDL) ou libelle lisible (direct). */
  title: string;
  quality: string;
  /** VF / VOSTFR / VO / MULTI. */
  language: string;
  sizeBytes?: number;
  seeders?: number;

  /** Pilier direct : URL jouable telle quelle (souvent du HLS). */
  directUrl?: string;
  /** En-tetes requis pour lire cette URL (Referer, User-Agent...). */
  headers?: Record<string, string>;

  /** Pilier torrent. */
  infoHash?: string;
  magnet?: string;

  /** Pilier DDL. */
  ddlUrl?: string;
  ddlHost?: string;

  /**
   * Lien vers le fichier .torrent, quand la source en fournit un.
   *
   * INDISPENSABLE POUR LES TRACKERS PRIVES. Un hash nu ne porte ni annonceur ni
   * metadonnees : le debrideur doit alors trouver des pairs par le DHT, ou les
   * torrents prives ne figurent pas. C'est ce qui rendait les magnets inertes chez
   * AllDebrid — deposes, jamais demarres, meme avec seize sources sur le tracker.
   */
  torrentUrl?: string;

  /** Fichier vise dans un torrent multi-fichiers ou un dossier debride. */
  fileHint?: string;

  /** Sous-titres portes par la source elle-meme (KissKH en fournit). */
  subs?: SubTrack[];

  /**
   * Langues des sous-titres INTEGRES au fichier, quand le tracker les publie.
   *
   * Certitude d'un tout autre ordre que l'etiquette du titre : c'est le MediaInfo du
   * fichier, pas une convention de nommage. Absent signifie « on ne sait pas », jamais
   * « il n'y en a pas » — la distinction commande le filtrage.
   */
  languesIntegrees?: string[];
}

export interface SearchContext {
  config: UserConfig;
  deadline: Deadline;
}

export interface Source {
  /** Identifiant stable, utilise dans la config utilisateur et les reglages admin. */
  id: string;
  /** Nom affiche dans les interfaces. */
  label: string;
  kind: SourceKind;
  /** Vrai si les resultats ne sont jouables qu'a travers un debrideur. */
  needsDebrid: boolean;
  /**
   * Cle utilisateur requise. Si elle manque, la source est ecartee du fan-out :
   * elle n'echoue pas et ne consomme pas de budget.
   */
  requiredUserKey?: 'ad' | 'tb' | 'c411' | 'tr4ker' | 'tmdb' | 'g3mini' | 'dcore' | 'ygg' | 'dpeers';
  search(q: Query, ctx: SearchContext): Promise<Candidate[]>;
  /** Sous-titres propres a la source, quand elle en expose. */
  subtitles?(q: Query, ctx: SearchContext): Promise<SubTrack[]>;
}
