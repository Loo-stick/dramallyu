// Journal consultable depuis l'administration.
//
// `docker logs` existe, mais il suppose un acces au serveur — or l'administration est
// faite pour se passer du serveur. Toutes les fois ou j'ai diagnostique un probleme
// pendant ce projet, la premiere chose regardee etait le journal : une source qui rend
// zero, une cle refusee, un lien mort. Il doit donc etre a portee de l'operateur.
//
// ON DETOURNE `console`, plutot que d'ajouter un appel a chaque endroit. Le code du
// projet ecrit deja ce qu'il faut, et sous une forme lisible ; le dupliquer creerait
// deux verites qui divergeraient. Le detournement conserve la sortie standard intacte
// — `docker logs` continue de tout recevoir.

import { masquer } from './masque';
import { capturerLigne } from './trace';

/** Lignes conservees. Bornees : rien ici ne doit croitre avec le trafic. */
const TAILLE = 500;

export type Niveau = 'info' | 'alerte' | 'erreur';

export interface Ligne {
  quand: number;
  niveau: Niveau;
  /** Prefixe entre crochets, quand la ligne en porte un : « Stream », « KissKH »... */
  source?: string;
  texte: string;
}

const lignes: Ligne[] = [];

/**
 * Categorise sans deviner.
 *
 * On ne se fie qu'a des marqueurs EXPLICITES : le canal d'ecriture, ou des mots qui
 * ne laissent pas de doute. Classer « erreur » une ligne banale rendrait le filtre
 * inutilisable, ce qui est pire que pas de filtre.
 */
function niveauDe(texte: string, canal: 'log' | 'error' | 'warn'): Niveau {
  if (canal === 'error') return 'erreur';
  if (canal === 'warn') return 'alerte';
  if (/\b(echec|erreur|refus|invalide|impossible)\b/i.test(texte)) return 'alerte';
  return 'info';
}

function prefixeDe(texte: string): string | undefined {
  const m = texte.match(/^\[([A-Za-zÀ-ÿ0-9 _-]{2,24})\]/);
  return m ? m[1] : undefined;
}

function ajouter(texte: string, canal: 'log' | 'error' | 'warn'): void {
  // Le masquage a lieu ICI, au point de passage unique, et avant tout le reste : c'est
  // ce qui garantit qu'aucun secret n'atteint ni la page d'administration, ni la trace
  // par utilisateur, ni la base. Le faire plus loin laisserait des chemins non couverts.
  const propre = masquer(texte.replace(/\s+$/, ''));
  if (!propre) return;
  const abrege = propre.slice(0, 500);
  lignes.push({
    quand: Date.now(),
    niveau: niveauDe(propre, canal),
    source: prefixeDe(propre),
    texte: abrege,
  });
  if (lignes.length > TAILLE) lignes.shift();
  // Et, si une requete est en cours, la meme ligne rejoint SA trace.
  capturerLigne(abrege);
}

let branche = false;

/**
 * Branche la capture. Idempotent : un second appel ne double pas les lignes.
 *
 * La sortie d'origine est TOUJOURS appelee. Perdre `docker logs` pour gagner une page
 * web serait un mauvais echange — c'est la seule trace qui survit a un plantage du
 * processus.
 */
export function brancherJournal(): void {
  if (branche) return;
  branche = true;

  for (const canal of ['log', 'error', 'warn'] as const) {
    const origine = console[canal].bind(console);
    console[canal] = (...args: unknown[]): void => {
      origine(...args);
      try {
        ajouter(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '), canal);
      } catch {
        // Le journal ne doit JAMAIS faire echouer ce qu'il observe.
      }
    };
  }
}

export interface FiltreJournal {
  niveau?: Niveau;
  source?: string;
  contient?: string;
  limite?: number;
}

/** Lignes du journal, de la plus recente a la plus ancienne. */
export function lire(f: FiltreJournal = {}): Ligne[] {
  const limite = Math.min(Math.max(f.limite ?? 200, 1), TAILLE);
  const besoin = f.contient?.toLowerCase();

  return lignes
    .filter((l) => {
      if (f.niveau && l.niveau !== f.niveau) return false;
      if (f.source && l.source !== f.source) return false;
      if (besoin && !l.texte.toLowerCase().includes(besoin)) return false;
      return true;
    })
    .slice(-limite)
    .reverse();
}

/** Prefixes rencontres, pour alimenter un filtre sans les coder en dur. */
export function sourcesConnues(): string[] {
  return [...new Set(lignes.map((l) => l.source).filter((s): s is string => Boolean(s)))].sort();
}

export function vider(): void {
  lignes.length = 0;
}
