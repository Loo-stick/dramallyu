// Mesures d'exploitation : ce que l'addon fait reellement, et a quel prix.
//
// Un tableau de bord qui n'affiche que des reglages ne sert a rien : il montre ce
// qu'on a decide, pas ce qui se passe. Toutes les questions qu'on s'est posees pendant
// le developpement — quelle source rapporte, laquelle est lente, laquelle echoue en
// silence, combien de recherches ne rendent rien — se repondent avec des CHIFFRES, et
// il faut donc les collecter.
//
// DEUX HORIZONS, volontairement :
//
//   - un anneau de requetes RECENTES, en memoire, pour le diagnostic immediat. Il
//     donne le detail par source, ce qu'aucun agregat ne remplace quand on cherche
//     pourquoi une recherche precise a echoue ;
//   - des compteurs par JOUR, persistes, pour la tendance. Ils survivent aux
//     redemarrages, sans quoi un redeploiement effacerait l'historique — et on
//     redeploie souvent.
//
// COUT MEMOIRE BORNE. L'anneau a une taille fixe et les compteurs sont des nombres :
// rien ici ne croit avec le trafic. C'est une contrainte de premier ordre sur cette
// machine, ou un depassement fige l'hote entier.

import { get, set } from './cache';

/** Requetes conservees pour le diagnostic. Au-dela, la plus ancienne sort. */
const TAILLE_ANNEAU = 200;

/** Les compteurs quotidiens sont gardes deux mois : de quoi voir une tendance. */
const TTL_JOUR_MS = 60 * 24 * 60 * 60 * 1000;

export interface RequeteMesuree {
  /** Millisecondes depuis l'epoque. */
  quand: number;
  type: 'movie' | 'series';
  id: string;
  titre?: string;
  /** Nombre de flux REELLEMENT renvoyes, apres filtres et plafond. */
  flux: number;
  /** Duree totale de la reponse. */
  ms: number;
  /** Duree par source, telle que le fan-out l'a mesuree. */
  parSource: Record<string, number>;
  /** Candidats rapportes par chaque source, AVANT dedup et filtres. */
  apports: Record<string, number>;
  /** Sources abandonnees faute de budget. */
  abandonnees: string[];
  /** Motif quand la reponse est vide malgre un fan-out complet. */
  note?: string;
}

const anneau: RequeteMesuree[] = [];

/** Statistiques vivantes d'une source, depuis le demarrage. */
interface EtatSource {
  appels: number;
  echecs: number;
  candidats: number;
  /** Somme des durees, pour la moyenne. */
  msTotal: number;
  /** Durees conservees pour les centiles. Bornees, cf. TAILLE_LATENCES. */
  latences: number[];
  dernierAppel?: number;
  dernierEchec?: { quand: number; message: string };
}

/** Assez pour un centile stable, assez peu pour ne rien couter. */
const TAILLE_LATENCES = 100;

const sources = new Map<string, EtatSource>();

function etat(id: string): EtatSource {
  let e = sources.get(id);
  if (!e) {
    e = { appels: 0, echecs: 0, candidats: 0, msTotal: 0, latences: [] };
    sources.set(id, e);
  }
  return e;
}

/** Jour courant en UTC, cle des compteurs persistes. */
function jour(quand = Date.now()): string {
  return new Date(quand).toISOString().slice(0, 10);
}

function incrementerJour(champ: string, de = 1): void {
  const cle = `metrics:${jour()}`;
  const actuel = (get<Record<string, number>>(cle) ?? {}) as Record<string, number>;
  actuel[champ] = (actuel[champ] ?? 0) + de;
  set(cle, actuel, TTL_JOUR_MS, 'metrics');
}

/** Une source vient de repondre. */
export function noterSource(id: string, ms: number, candidats: number, echec?: string): void {
  const e = etat(id);
  e.appels++;
  e.candidats += candidats;
  e.msTotal += ms;
  e.dernierAppel = Date.now();
  e.latences.push(ms);
  if (e.latences.length > TAILLE_LATENCES) e.latences.shift();
  if (echec) {
    e.echecs++;
    e.dernierEchec = { quand: Date.now(), message: echec.slice(0, 200) };
  }
}

/** Une requete /stream vient d'aboutir. */
export function noterRequete(r: RequeteMesuree): void {
  anneau.push(r);
  if (anneau.length > TAILLE_ANNEAU) anneau.shift();

  incrementerJour('requetes');
  incrementerJour('flux', r.flux);
  if (r.flux === 0) incrementerJour('vides');
  incrementerJour('ms', r.ms);
}

/** Une lecture a ete demandee, et ce qu'elle a donne. */
export function noterLecture(ok: boolean, service?: string): void {
  incrementerJour(ok ? 'lectures' : 'lectures_echec');
  if (ok && service) incrementerJour(`lecture_${service}`);
}

function centile(valeurs: number[], p: number): number {
  if (valeurs.length === 0) return 0;
  const tri = [...valeurs].sort((a, b) => a - b);
  const rang = Math.min(tri.length - 1, Math.floor((p / 100) * tri.length));
  return tri[rang];
}

export interface StatSource {
  id: string;
  appels: number;
  echecs: number;
  candidats: number;
  /** Candidats par appel : la vraie mesure de l'utilite d'une source. */
  rendement: number;
  msMoyen: number;
  msP95: number;
  dernierAppel?: number;
  dernierEchec?: { quand: number; message: string };
}

export function statsSources(): StatSource[] {
  return [...sources.entries()]
    .map(([id, e]) => ({
      id,
      appels: e.appels,
      echecs: e.echecs,
      candidats: e.candidats,
      rendement: e.appels > 0 ? Number((e.candidats / e.appels).toFixed(2)) : 0,
      msMoyen: e.appels > 0 ? Math.round(e.msTotal / e.appels) : 0,
      msP95: centile(e.latences, 95),
      dernierAppel: e.dernierAppel,
      dernierEchec: e.dernierEchec,
    }))
    .sort((a, b) => b.candidats - a.candidats);
}

/** Les N dernieres requetes, de la plus recente a la plus ancienne. */
export function requetesRecentes(n = 50): RequeteMesuree[] {
  return anneau.slice(-n).reverse();
}

export interface ResumeGlobal {
  requetes: number;
  fluxTotal: number;
  vides: number;
  msMoyen: number;
  /** Centiles calcules sur l'anneau : ils disent ce que vit l'utilisateur. */
  msP50: number;
  msP95: number;
  lectures: number;
  lecturesEchec: number;
}

/** Resume du jour, complete par les centiles de l'anneau. */
export function resumeDuJour(): ResumeGlobal {
  const j = (get<Record<string, number>>(`metrics:${jour()}`) ?? {}) as Record<string, number>;
  const durees = anneau.map((r) => r.ms);
  const requetes = j.requetes ?? 0;
  return {
    requetes,
    fluxTotal: j.flux ?? 0,
    vides: j.vides ?? 0,
    msMoyen: requetes > 0 ? Math.round((j.ms ?? 0) / requetes) : 0,
    msP50: centile(durees, 50),
    msP95: centile(durees, 95),
    lectures: j.lectures ?? 0,
    lecturesEchec: j.lectures_echec ?? 0,
  };
}

/** Compteurs des N derniers jours, du plus ancien au plus recent. */
export function historique(jours = 14): { jour: string; requetes: number; flux: number; vides: number }[] {
  const out: { jour: string; requetes: number; flux: number; vides: number }[] = [];
  for (let i = jours - 1; i >= 0; i--) {
    const d = jour(Date.now() - i * 24 * 60 * 60 * 1000);
    const j = (get<Record<string, number>>(`metrics:${d}`) ?? {}) as Record<string, number>;
    out.push({ jour: d, requetes: j.requetes ?? 0, flux: j.flux ?? 0, vides: j.vides ?? 0 });
  }
  return out;
}

/** Remet les compteurs vivants a zero. Les compteurs persistes ne bougent pas. */
export function reinitialiser(): void {
  anneau.length = 0;
  sources.clear();
}
