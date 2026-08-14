// Activite par installation, conservee sur disque.
//
// POURQUOI DU DURABLE. Les mesures de `metrics.ts` vivent en memoire : elles repondent
// tres bien a « comment va le serveur maintenant », et disparaissent au redemarrage —
// or on redeploie plusieurs fois par jour. Le signalement, lui, arrive apres : « hier
// soir je n'avais rien ». Sans trace ecrite, la reponse est perdue avant meme d'etre
// cherchee. C'est exactement le manque constate.
//
// CE QU'ON ECRIT. Une ligne par recherche : qui, quoi, combien de flux, l'issue, le
// detail par source, et — seulement quand ca vaut la peine — la trace complete des
// lignes de journal de cette requete.
//
// CE QU'ON N'ECRIT PAS. Aucune cle, aucune configuration, jamais : les traces arrivent
// masquees (`masque.ts`), et rien d'autre n'est stocke que ce que cette interface
// declare. L'affirmation de la page d'administration reste vraie.
//
// COUT MAITRISE. Base dediee, ajout indexe, retention bornee, et la trace n'est gardee
// que pour les requetes qui posent probleme. Un succes ordinaire coute quelques
// centaines d'octets ; ce sont les echecs, rares, qui coutent quelques kilo-octets —
// et ce sont les seuls qu'on relira.

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

function chemin(): string {
  return (
    process.env.ACTIVITE_DB_PATH ||
    (fs.existsSync('/app/config')
      ? '/app/config/activite.db'
      : path.join(process.cwd(), 'config', 'activite.db'))
  );
}

/** Au-dela, une trace ne sert plus a diagnostiquer : elle encombre. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Plafond dur sur une trace ecrite. Borne le pire cas d'une ligne. */
const MAX_TRACE = 16 * 1024;

/**
 * La base s'ouvre a la PREMIERE utilisation, pas au chargement du module.
 *
 * Un module qui cree un fichier des qu'on l'importe est un module qu'on ne peut pas
 * tester : en modules ES, les imports sont evalues avant la premiere ligne du fichier
 * appelant, donc avant toute possibilite de lui designer une autre base. Les premieres
 * executions du test de ce fichier ont ainsi ecrit dans la base de PRODUCTION, sans
 * qu'aucun signal ne l'indique. L'ouverture paresseuse supprime le probleme a la
 * racine, et evite au passage un acces disque au demarrage.
 */
let connexion: Database.Database | null = null;

function db(): Database.Database {
  if (connexion) return connexion;
  const fichier = chemin();
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  connexion = new Database(fichier);
  connexion.pragma('journal_mode = WAL');
  connexion.exec(`
  CREATE TABLE IF NOT EXISTS activite (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qui TEXT NOT NULL,
    quand INTEGER NOT NULL,
    type TEXT,
    contenu TEXT,
    titre TEXT,
    flux INTEGER NOT NULL DEFAULT 0,
    issue TEXT NOT NULL,
    ms INTEGER,
    detail TEXT,
    trace TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_activite_qui ON activite(qui, quand);
  CREATE INDEX IF NOT EXISTS idx_activite_quand ON activite(quand);
`);
  return connexion;
}

/** Requetes preparees, gardees par texte : preparer coute, et on repete les memes. */
const preparees = new Map<string, Database.Statement>();

function req(sql: string): Database.Statement {
  let s = preparees.get(sql);
  if (!s) {
    s = db().prepare(sql);
    preparees.set(sql, s);
  }
  return s;
}

/**
 * Issue d'une recherche.
 *
 * `vide` et `hors-creneau` sont distingues a dessein : les deux rendent une liste vide,
 * mais l'un est une panne possible et l'autre le fonctionnement normal. Les confondre
 * ferait passer une navigation ordinaire pour un incident — et noyerait les vrais.
 */
export type Issue = 'ok' | 'vide' | 'hors-creneau' | 'inconnu' | 'erreur';

export interface EntreeActivite {
  qui: string;
  type?: string;
  contenu?: string;
  titre?: string;
  flux: number;
  issue: Issue;
  ms?: number;
  /** Resume par source, tel que le fan-out l'a mesure. */
  detail?: unknown;
  trace?: string;
}

const SQL_INSERTION = `
  INSERT INTO activite (qui, quand, type, contenu, titre, flux, issue, ms, detail, trace)
  VALUES (@qui, @quand, @type, @contenu, @titre, @flux, @issue, @ms, @detail, @trace)
`;

export function enregistrer(e: EntreeActivite): void {
  // Une recherche anonyme n'a personne a qui etre rattachee : la conserver ne
  // servirait aucun diagnostic, et `metrics.ts` la compte deja.
  if (!e.qui) return;
  try {
    req(SQL_INSERTION).run({
      qui: e.qui,
      quand: Date.now(),
      type: e.type ?? null,
      contenu: e.contenu ?? null,
      titre: e.titre ?? null,
      flux: e.flux | 0,
      issue: e.issue,
      ms: e.ms ?? null,
      detail: e.detail ? JSON.stringify(e.detail).slice(0, 4096) : null,
      trace: e.trace ? e.trace.slice(0, MAX_TRACE) : null,
    });
  } catch (err) {
    // Le suivi ne doit jamais empecher une reponse : on note et on continue.
    console.error(`[Activite] ecriture impossible : ${(err as Error).message}`);
  }
}

export interface ResumeUtilisateur {
  qui: string;
  requetes: number;
  vides: number;
  erreurs: number;
  horsCreneau: number;
  /** Recherches problematiques des sept derniers jours : le tri par urgence. */
  soucisRecents: number;
  premierVu: number;
  dernierVu: number;
  msMoyen: number;
}

const SQL_RESUME = `
  SELECT qui,
         COUNT(*) AS requetes,
         SUM(issue = 'vide') AS vides,
         SUM(issue = 'erreur') AS erreurs,
         SUM(issue = 'hors-creneau') AS horsCreneau,
         SUM(issue IN ('vide','erreur') AND quand > ?) AS soucisRecents,
         MIN(quand) AS premierVu,
         MAX(quand) AS dernierVu,
         CAST(AVG(ms) AS INTEGER) AS msMoyen
  FROM activite
  GROUP BY qui
  ORDER BY soucisRecents DESC, dernierVu DESC
  LIMIT 500
`;

/** Une ligne par installation, les plus en difficulte d'abord. */
export function resumeUtilisateurs(): ResumeUtilisateur[] {
  return req(SQL_RESUME).all(Date.now() - 7 * 24 * 60 * 60 * 1000) as ResumeUtilisateur[];
}

export interface LigneActivite {
  id: number;
  quand: number;
  type: string | null;
  contenu: string | null;
  titre: string | null;
  flux: number;
  issue: Issue;
  ms: number | null;
  detail: string | null;
  /** La trace n'est pas renvoyee avec la liste : elle se demande ligne par ligne. */
  aUneTrace: number;
}

const SQL_REQUETES = `
  SELECT id, quand, type, contenu, titre, flux, issue, ms, detail,
         (trace IS NOT NULL) AS aUneTrace
  FROM activite WHERE qui = ? ORDER BY quand DESC LIMIT ?
`;

export function requetesDe(qui: string, limite = 40): LigneActivite[] {
  return req(SQL_REQUETES).all(qui, Math.min(Math.max(limite, 1), 200)) as LigneActivite[];
}

const SQL_TRACE = 'SELECT trace FROM activite WHERE id = ?';

export function traceDe(id: number): string | null {
  const r = req(SQL_TRACE).get(id) as { trace: string | null } | undefined;
  return r?.trace ?? null;
}

const SQL_OUBLI = 'DELETE FROM activite WHERE qui = ?';

/** Efface toute l'activite d'une installation. Renvoie le nombre de lignes retirees. */
export function oublier(qui: string): number {
  return req(SQL_OUBLI).run(qui).changes;
}

const SQL_PURGE = 'DELETE FROM activite WHERE quand < ?';

export function purger(): number {
  return req(SQL_PURGE).run(Date.now() - RETENTION_MS).changes;
}

// La retention doit s'appliquer meme si personne ne visite l'administration pendant des
// semaines. `unref` pour ne pas retenir le processus a l'arret.
setInterval(
  () => {
    const n = purger();
    if (n > 0) console.log(`[Activite] ${n} ligne(s) au-dela de 30 jours retirees`);
  },
  6 * 60 * 60 * 1000,
).unref();
