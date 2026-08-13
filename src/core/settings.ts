// Reglages OPERATEUR (page admin), a chaud dans config/runtime-settings.json.
//
// Ce fichier ne contient AUCUNE cle d'acces : l'operateur pilote la disponibilite
// (quelle source est active, a quelle adresse la joindre), jamais les acces, qui
// appartiennent a chaque utilisateur.
//
// PIEGE EVITE : LooStream met ses reglages en cache dans le processus, si bien
// qu'editer le fichier reste sans effet jusqu'au redemarrage. Ici on lit toujours
// a travers endpoint-config, qui surveille le fichier — editer = applique.

import { makeEndpointConfig } from './endpoint-config';

export interface TorznabIndexerSettings {
  enabled: boolean;
  /** URL de base de l'API Torznab. La CLE reste dans la config de l'utilisateur. */
  url: string;
  /** Categories Torznab a interroger (5000 = TV, 2000 = films). */
  categories: number[];
}

export interface Settings {
  /** Activation par source. Une source absente est consideree active. */
  sources: Record<string, boolean>;
  /** Budget dur du fan-out. Au-dela, les sources en retard sont abandonnees. */
  fanoutBudgetMs: number;
  /**
   * Plafond DUR de la reponse /stream, enrichissements compris.
   *
   * Le budget de fan-out ne bornait que l'interrogation des sources. Tout ce qui vient
   * apres — verification du cache debrid, etat des liens DDL — s'y ajoutait sans
   * limite : mesure a 12,8 s dont 6,9 d'enrichissement. Un lecteur n'attend pas, et
   * AIOStreams coupe. Ce plafond-ci gouverne le tout, et ce qui n'a pas le temps de se
   * faire est simplement omis — une etiquette manquante vaut mieux qu'une reponse
   * qui n'arrive pas.
   */
  reponseMaxMs: number;
  /** Nombre maximum de flux renvoyes, toutes sources confondues. */
  maxStreams: number;
  torznab: Record<string, TorznabIndexerSettings>;
  /** Trackers UNIT3D (G3mini...). Meme forme que Torznab : l'adresse est a
   *  l'operateur, la cle reste a l'utilisateur. */
  unit3d: Record<string, { enabled: boolean; url: string }>;
  digitalcore: { enabled: boolean; url: string };
}

const DEFAULTS: Settings = {
  sources: {
    kisskh: true,
    voirdrama: true,
    nyaa: true,
    c411: true,
    tr4ker: true,
    zonetelechargement: true,
    g3mini: true,
    digitalcore: true,
    yggreborn: true,
    darkpeers: true,
    // Wawacity publie beaucoup sur des hebergeurs qu'AllDebrid ne prend pas (Uploady,
    // DailyUploads, Nitroflare) mais que TorBox prend. Le tri se fait desormais sur la
    // liste que chaque service publie, et non sur une liste ecrite a la main.
    wawacity: true,
  },
  // 8 s : au-dela, AIOStreams coupe la source et l'utilisateur voit un ecran vide.
  fanoutBudgetMs: 8000,
  reponseMaxMs: 5000,
  maxStreams: 60,
  torznab: {
    c411: { enabled: true, url: 'https://c411.org/api', categories: [2000, 5000] },
    tr4ker: { enabled: true, url: 'https://tr4ker.net/torznab', categories: [2000, 5000] },
    // YggReborn, successeur de YggTorrent. Torznab standard, passkey par utilisateur.
    // A ne pas confondre avec les relais « ygg.gratis » / « u2p.anhkagi.net », tous
    // deux morts (404 et 403 verifies le 2026-08-13, y compris depuis stream-fusion).
    yggreborn: { enabled: true, url: 'https://api.yggreborn.org/api', categories: [2000, 5000] },
    // Le relais YggTorrent a ete RETIRE le 2026-08-13 : `u2p.anhkagi.net` repond 403
    // depuis ce serveur (ni cle acceptee, ni IP autorisee), et stream-fusion — d'ou
    // venait l'adresse — n'a aucun mecanisme de cle pour lui. Ajouter un indexeur ici
    // suffit a le faire revenir : une entree dans cette table, une ligne dans
    // torznabSources(), un champ dans la page de configuration.
  },
  // Trackers PRIVES : sans cle personnelle ils ne repondent pas, et l'operateur n'en
  // fournit aucune. Actives par defaut ne coute donc rien a qui n'a pas de compte —
  // la source est simplement ignoree dans son fan-out.
  unit3d: {
    g3mini: { enabled: true, url: 'https://gemini-tracker.org' },
    darkpeers: { enabled: true, url: 'https://darkpeers.org' },
  },
  digitalcore: { enabled: true, url: 'https://digitalcore.club' },
};

const store = makeEndpointConfig<Record<string, unknown>>(
  'runtime-settings.json',
  'RUNTIME_SETTINGS_CONFIG',
  DEFAULTS as unknown as Record<string, unknown>,
);

export const reloadSettings = store.reload;
export const settingsPath = store.path;

export function getSettings(): Settings {
  const raw = store.get() as Partial<Settings>;
  return {
    sources: { ...DEFAULTS.sources, ...(raw.sources || {}) },
    fanoutBudgetMs: clamp(Number(raw.fanoutBudgetMs) || DEFAULTS.fanoutBudgetMs, 2000, 20000),
    reponseMaxMs: clamp(Number(raw.reponseMaxMs) || DEFAULTS.reponseMaxMs, 2000, 30000),
    maxStreams: clamp(Number(raw.maxStreams) || DEFAULTS.maxStreams, 5, 300),
    torznab: { ...DEFAULTS.torznab, ...(raw.torznab || {}) },
    unit3d: { ...DEFAULTS.unit3d, ...(raw.unit3d || {}) },
    digitalcore: { ...DEFAULTS.digitalcore, ...(raw.digitalcore || {}) },
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Une source est-elle autorisee par l'operateur ? Absente du fichier = autorisee. */
export function sourceEnabledByOperator(sourceId: string): boolean {
  const s = getSettings().sources;
  return s[sourceId] !== false;
}
