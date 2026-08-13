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
  /** Nombre maximum de flux renvoyes, toutes sources confondues. */
  maxStreams: number;
  torznab: Record<string, TorznabIndexerSettings>;
}

const DEFAULTS: Settings = {
  sources: {
    kisskh: true,
    voirdrama: true,
    nyaa: true,
    c411: true,
    tr4ker: true,
    zonetelechargement: true,
    // DESACTIVEE le 2026-08-13, apres verification en production.
    //
    // Wawacity place TOUS ses liens derriere `dl-protect`, dont la page de sortie est
    // protegee par un captcha Cloudflare Turnstile. AllDebrid refuse ces liens
    // (LINK_HOST_NOT_SUPPORTED) et son endpoint /link/redirector n'en extrait rien.
    // Nous ne pouvons pas davantage les resoudre : un captcha ne se contourne pas.
    //
    // La source fonctionne donc parfaitement pour TROUVER des fichiers — 21 resultats
    // sur un episode — mais aucun n'est jouable. Les afficher etait pire que de ne
    // rien afficher : ils occupaient la liste, repoussaient des flux valides hors du
    // plafond, et chaque clic menait a une erreur.
    //
    // A reactiver si dl-protect abandonne le captcha, ou si un debrideur apprend a le
    // traverser. Le code du scraper reste entier et teste.
    wawacity: false,
  },
  // 8 s : au-dela, AIOStreams coupe la source et l'utilisateur voit un ecran vide.
  fanoutBudgetMs: 8000,
  maxStreams: 60,
  torznab: {
    c411: { enabled: true, url: 'https://c411.org/api', categories: [2000, 5000] },
    tr4ker: { enabled: true, url: 'https://tr4ker.net/torznab', categories: [2000, 5000] },
    // Le relais YggTorrent a ete RETIRE le 2026-08-13 : `u2p.anhkagi.net` repond 403
    // depuis ce serveur (ni cle acceptee, ni IP autorisee), et stream-fusion — d'ou
    // venait l'adresse — n'a aucun mecanisme de cle pour lui. Ajouter un indexeur ici
    // suffit a le faire revenir : une entree dans cette table, une ligne dans
    // torznabSources(), un champ dans la page de configuration.
  },
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
    maxStreams: clamp(Number(raw.maxStreams) || DEFAULTS.maxStreams, 5, 300),
    torznab: { ...DEFAULTS.torznab, ...(raw.torznab || {}) },
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
