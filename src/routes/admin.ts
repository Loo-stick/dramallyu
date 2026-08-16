// Page ADMIN (operateur) : disponibilite des sources, domaines rotatifs, sante, cache.
//
// Elle ne detient AUCUNE cle d'acces : celles-ci appartiennent aux utilisateurs. Ce
// que l'operateur pilote ici, c'est ce qui est a lui — quelles sources tournent, a
// quelle adresse on joint chaque site, et l'etat du service.
//
// Si ADMIN_PASSWORD est absent du .env, la page est entierement DESACTIVEE. Une page
// d'administration sans mot de passe serait pire que pas de page du tout.

import type { Request, Response, NextFunction } from 'express';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSettings, reloadSettings, settingsPath } from '../core/settings';
import { clearAll, clearScope, getCacheStats, clesDuPerimetre } from '../core/cache';
import { allSources, planSources } from '../core/registry';
import type { Source } from '../sources/types';
import { kkeyStatus, rediscoverConstants, reloadKkeyConfig } from '../sources/direct/kisskh/kkey';
import {
  statsSources,
  resumeDuJour,
  historique,
  requetesRecentes,
  reinitialiser as reinitialiserMesures,
  statsUtilisateurs,
  utilisateursSatures,
} from '../core/metrics';
import { resumeUtilisateurs, requetesDe, traceDe, oublier } from '../core/activite';
import { lire, sourcesConnues, vider as viderJournal } from '../core/journal';
import { parseConfig, chiffrementDisponible, type UserConfig } from '../core/config';
import { parseStremioId } from '../core/ids';
import { resolveWork, chercherOeuvre } from '../core/meta';
import type { Query } from '../sources/types';
import { Deadline } from '../core/http';
import { kisskhBase } from '../sources/direct/kisskh/client';

const COOKIE = 'dramallyu_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function adminEnabled(): boolean {
  return Boolean((process.env.ADMIN_PASSWORD || '').trim());
}

function sessionSecret(): string {
  return (process.env.TOKEN_SECRET || '') + (process.env.ADMIN_PASSWORD || '');
}

function makeSession(): string {
  const expires = Date.now() + SESSION_TTL_MS;
  const mac = crypto.createHmac('sha256', sessionSecret()).update(String(expires)).digest('base64url');
  return `${expires}.${mac}`;
}

function validSession(value: string | undefined): boolean {
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const expires = Number(value.slice(0, dot));
  if (!Number.isFinite(expires) || expires < Date.now()) return false;

  const expected = crypto.createHmac('sha256', sessionSecret()).update(String(expires)).digest('base64url');
  const given = value.slice(dot + 1);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Lit le cookie sans dependance : une seule valeur nous interesse. */
function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!adminEnabled()) {
    res.status(404).type('text/plain').send('administration desactivee (ADMIN_PASSWORD absent)');
    return;
  }
  if (!validSession(readCookie(req, COOKIE))) {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ erreur: 'session requise' });
    } else {
      res.redirect('/admin/login');
    }
    return;
  }
  next();
}

export function handleLogin(req: Request, res: Response): void {
  const given = String((req.body as Record<string, unknown>)?.password || '');
  const expected = (process.env.ADMIN_PASSWORD || '').trim();

  // Comparaison a temps constant, et longueurs egalisees : sinon la duree de la
  // reponse renseigne sur la longueur du mot de passe.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!expected || !crypto.timingSafeEqual(a, b)) {
    res.status(401).type('text/html; charset=utf-8').send(
      '<p style="font-family:system-ui;padding:2rem">Mot de passe incorrect. <a href="/admin/login">Reessayer</a></p>',
    );
    return;
  }

  res.cookie?.(COOKIE, makeSession(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: SESSION_TTL_MS,
  });
  if (!res.cookie) {
    res.setHeader('Set-Cookie', `${COOKIE}=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  }
  res.redirect('/admin');
}

export function handleLogout(_req: Request, res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.redirect('/admin/login');
}

/** Fichiers de configuration editables a chaud, decouverts dans config/. */
function configDir(): string {
  return fs.existsSync('/app/config') ? '/app/config' : path.join(process.cwd(), 'config');
}

export function listConfigFiles(): { name: string; contenu: string }[] {
  const dir = configDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((name) => {
      try {
        return { name, contenu: fs.readFileSync(path.join(dir, name), 'utf-8') };
      } catch {
        return { name, contenu: '' };
      }
    });
}

export function handleGetConfigFiles(_req: Request, res: Response): void {
  res.json({ fichiers: listConfigFiles(), dossier: configDir() });
}

export function handleSaveConfigFile(req: Request, res: Response): void {
  const name = String(req.params.name || '');
  // Un nom de fichier venu du client ne doit jamais pouvoir sortir du dossier.
  if (!/^[a-z0-9._-]+\.json$/i.test(name) || name.includes('..')) {
    res.status(400).json({ erreur: 'nom de fichier invalide' });
    return;
  }

  const contenu = String((req.body as Record<string, unknown>)?.contenu || '');
  try {
    JSON.parse(contenu);
  } catch (e) {
    res.status(400).json({ erreur: `JSON invalide : ${(e as Error).message}` });
    return;
  }

  try {
    fs.writeFileSync(path.join(configDir(), name), contenu, 'utf-8');
    // fs.watch recharge tout seul, mais un rechargement explicite evite de dependre
    // d'un evenement que certains systemes de fichiers ne remontent pas.
    reloadSettings();
    reloadKkeyConfig();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erreur: (e as Error).message });
  }
}

export function handleAdminState(_req: Request, res: Response): void {
  res.json({
    settings: getSettings(),
    settingsPath,
    sources: allSources().map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
      needsDebrid: s.needsDebrid,
      requiredUserKey: s.requiredUserKey,
      active: getSettings().sources[s.id] !== false,
    })),
    cache: getCacheStats(),
    kkey: kkeyStatus(),
    memoireMo: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptimeSecondes: Math.round(process.uptime()),
  });
}

export function handleToggleSource(req: Request, res: Response): void {
  const id = String(req.params.id || '');
  const actif = Boolean((req.body as Record<string, unknown>)?.actif);

  try {
    const file = settingsPath;
    const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
    current.sources = { ...(current.sources || {}), [id]: actif };
    fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf-8');
    reloadSettings();
    res.json({ ok: true, sources: getSettings().sources });
  } catch (e) {
    res.status(500).json({ erreur: (e as Error).message });
  }
}

export function handleClearCache(req: Request, res: Response): void {
  const scope = String((req.body as Record<string, unknown>)?.scope || '');
  const supprimees = scope ? clearScope(scope) : clearAll();
  res.json({ ok: true, supprimees });
}

/**
 * Fabrique un TOKEN_SECRET, et dit quoi en faire.
 *
 * On ne peut PAS l'installer soi-meme : il est lu dans l'environnement au demarrage,
 * l'ecrire quelque part ne changerait rien sans redemarrage, et sur bon nombre
 * d'hebergeurs le fichier `.env` n'existe meme pas — ce sont des variables declarees
 * dans une interface. La valeur ajoutee est ailleurs : produire une valeur assez
 * solide, et rappeler ce que sa mise en place implique.
 *
 * Sans lui, /configure rend des liens NON CHIFFRES — les cles y sont lisibles — et
 * aucune lecture ne fonctionne. Un exploitant doit pouvoir regler ça sans aller lire
 * la documentation.
 */
export function handleGenererSecret(_req: Request, res: Response): void {
  res.json({
    secret: crypto.randomBytes(48).toString('base64url'),
    dejaConfigure: Boolean((process.env.TOKEN_SECRET || '').trim().length >= 16),
  });
}

export async function handleRediscoverKkey(_req: Request, res: Response): Promise<void> {
  const found = await rediscoverConstants();
  res.json({ ok: Boolean(found), constantes: found, etat: kkeyStatus() });
}

// ---------------------------------------------------------------------------
// TABLEAU DE BORD
//
// Ce qui suit repond aux questions qu'on se pose vraiment en exploitation, et
// qu'aucune page de reglages ne resout : quelle source rapporte, laquelle est
// lente, laquelle echoue en silence, pourquoi CETTE recherche n'a rien rendu.
// ---------------------------------------------------------------------------

/** Vue d'ensemble : le premier ecran, celui qu'on regarde en arrivant. */
export function handleTableauDeBord(_req: Request, res: Response): void {
  const settings = getSettings();
  const stats = statsSources();
  const parId = new Map(stats.map((s) => [s.id, s]));

  res.json({
    resume: resumeDuJour(),
    historique: historique(14),
    sources: allSources().map((s) => {
      const m = parId.get(s.id);
      return {
        id: s.id,
        label: s.label,
        kind: s.kind,
        needsDebrid: s.needsDebrid,
        requiredUserKey: s.requiredUserKey,
        active: settings.sources[s.id] !== false,
        appels: m?.appels ?? 0,
        echecs: m?.echecs ?? 0,
        candidats: m?.candidats ?? 0,
        rendement: m?.rendement ?? 0,
        msMoyen: m?.msMoyen ?? 0,
        msP95: m?.msP95 ?? 0,
        dernierAppel: m?.dernierAppel,
        dernierEchec: m?.dernierEchec,
      };
    }),
    cache: getCacheStats(),
    kkey: kkeyStatus(),
    systeme: {
      memoireMo: Math.round(process.memoryUsage().rss / 1024 / 1024),
      tasMo: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      uptimeSecondes: Math.round(process.uptime()),
      node: process.version,
      chiffrement: chiffrementDisponible(),
    },
  });
}

/** Requetes recentes, avec le detail par source. C'est l'outil de diagnostic. */
export function handleRequetes(req: Request, res: Response): void {
  const n = Math.min(Math.max(Number(req.query.n) || 50, 1), 200);
  res.json({ requetes: requetesRecentes(n) });
}

export function handleJournal(req: Request, res: Response): void {
  const niveau = String(req.query.niveau || '');
  res.json({
    lignes: lire({
      niveau: niveau === 'info' || niveau === 'alerte' || niveau === 'erreur' ? niveau : undefined,
      source: String(req.query.source || '') || undefined,
      contient: String(req.query.contient || '') || undefined,
      limite: Number(req.query.limite) || 200,
    }),
    sources: sourcesConnues(),
  });
}

export function handleViderJournal(_req: Request, res: Response): void {
  viderJournal();
  res.json({ ok: true });
}

export function handleReinitialiserMesures(_req: Request, res: Response): void {
  reinitialiserMesures();
  res.json({ ok: true });
}

/**
 * Reglages operateur modifiables depuis la page.
 *
 * Seuls les champs LISTES ici sont acceptes. Ecrire le corps de la requete tel quel
 * dans le fichier laisserait n'importe qui y injecter des cles inventees, et une
 * faute de frappe suffirait a rendre les reglages illisibles au demarrage suivant.
 */
export function handleEnregistrerReglages(req: Request, res: Response): void {
  const corps = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if (corps.fanoutBudgetMs !== undefined) {
    const v = Number(corps.fanoutBudgetMs);
    if (!Number.isFinite(v) || v < 2000 || v > 20000) {
      res.status(400).json({ erreur: 'budget de fan-out hors bornes (2000 a 20000 ms)' });
      return;
    }
    patch.fanoutBudgetMs = Math.round(v);
  }

  if (corps.reponseMaxMs !== undefined) {
    const v = Number(corps.reponseMaxMs);
    if (!Number.isFinite(v) || v < 2000 || v > 30000) {
      res.status(400).json({ erreur: 'plafond de reponse hors bornes (2000 a 30000 ms)' });
      return;
    }
    patch.reponseMaxMs = Math.round(v);
  }

  if (corps.maxStreams !== undefined) {
    const v = Number(corps.maxStreams);
    if (!Number.isFinite(v) || v < 5 || v > 300) {
      res.status(400).json({ erreur: 'nombre de flux hors bornes (5 a 300)' });
      return;
    }
    patch.maxStreams = Math.round(v);
  }

  if (corps.rechauffementMs !== undefined) {
    const v = Number(corps.rechauffementMs);
    if (!Number.isFinite(v) || v < 2000 || v > 60000) {
      res.status(400).json({ erreur: 'delai de rechauffement hors bornes (2000 a 60000 ms)' });
      return;
    }
    patch.rechauffementMs = Math.round(v);
  }

  if (corps.tracerTout !== undefined) patch.tracerTout = corps.tracerTout === true;

  for (const [famille, cle] of [
    ['torznab', 'torznab'],
    ['unit3d', 'unit3d'],
  ] as const) {
    const table = corps[famille];
    if (!table || typeof table !== 'object') continue;
    const propre: Record<string, unknown> = {};
    for (const [id, valeur] of Object.entries(table as Record<string, unknown>)) {
      if (!/^[a-z0-9_-]+$/i.test(id) || !valeur || typeof valeur !== 'object') continue;
      const v = valeur as Record<string, unknown>;
      const url = String(v.url ?? '');
      // Une adresse d'indexeur qui n'est pas une URL rendrait la source muette sans
      // que rien ne l'explique : on refuse ici plutot que d'echouer a chaque recherche.
      if (url && !/^https?:\/\/\S+$/i.test(url)) {
        res.status(400).json({ erreur: `adresse invalide pour « ${id} »` });
        return;
      }
      propre[id] = {
        enabled: v.enabled !== false,
        url,
        ...(Array.isArray(v.categories) ? { categories: v.categories.map(Number).filter(Number.isFinite) } : {}),
      };
    }
    patch[cle] = propre;
  }

  if (corps.digitalcore && typeof corps.digitalcore === 'object') {
    const v = corps.digitalcore as Record<string, unknown>;
    const url = String(v.url ?? '');
    if (url && !/^https?:\/\/\S+$/i.test(url)) {
      res.status(400).json({ erreur: 'adresse invalide pour DigitalCore' });
      return;
    }
    patch.digitalcore = { enabled: v.enabled !== false, url };
  }

  try {
    const actuel = fs.existsSync(settingsPath)
      ? (JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>)
      : {};
    // Fusion superficielle volontaire : les tables d'indexeurs sont remplacees en
    // entier, sinon retirer une entree depuis la page serait impossible.
    fs.writeFileSync(settingsPath, JSON.stringify({ ...actuel, ...patch }, null, 2), 'utf-8');
    reloadSettings();
    res.json({ ok: true, settings: getSettings() });
  } catch (e) {
    res.status(500).json({ erreur: (e as Error).message });
  }
}

/**
 * Essai reel d'une source, avec un titre au choix.
 *
 * C'est le seul moyen honnete de dire si une source fonctionne : la mesure passive ne
 * dit rien tant que personne n'a cherche. On execute donc la VRAIE recherche, avec les
 * cles fournies pour l'essai — jamais memorisees.
 */
/**
 * Extrait le segment de configuration d'un lien d'installation.
 *
 * Ce qu'on a sous la main, c'est le lien entier : c'est lui qu'on copie depuis la page
 * de configuration, lui qu'on colle dans Stremio. Exiger d'en isoler un morceau a la
 * main serait une petite corvee inutile — et une source d'erreur silencieuse, puisqu'un
 * collage errone donne simplement une configuration vide.
 */
export function segmentDeConfig(entree: string): string {
  const texte = entree.trim();
  if (!texte) return '';
  const m = texte.match(/(?:^|\/)((?:e1\.)?[A-Za-z0-9_-]{16,})(?:\/|$)/);
  return m ? m[1] : texte;
}

/**
 * Pourquoi une source n'a pas ete interrogee, en clair.
 *
 * `planSources` reunit sous « cle-absente » deux situations tres differentes pour qui
 * lit le resultat : la cle du tracker manque, ou aucun debrideur n'est configure. On
 * les distingue ici, dans la formulation seulement — la decision, elle, reste unique.
 */
function raisonIgnoree(source: Source, config: UserConfig, skip: string): string {
  if (skip === 'operateur') {
    return 'Source desactivee dans l onglet Sources : elle ne participe a aucune recherche reelle.';
  }
  if (skip === 'utilisateur') {
    return 'La configuration fournie a desactive cette source.';
  }
  if (source.requiredUserKey && !config[source.requiredUserKey]) {
    return (
      `Aucune cle « ${source.requiredUserKey} » dans la configuration fournie. ` +
      'Les cles de trackers appartiennent aux utilisateurs : collez ci-dessous un lien ' +
      'de configuration qui en porte une, sinon la source ne peut rien chercher.'
    );
  }
  if (source.needsDebrid) {
    // Nommer ce que la source rend vraiment : parler de torrents a propos de
    // Zone-Telechargement ferait douter de l'exactitude du reste du message.
    const rendus = source.kind === 'ddl' ? 'des liens d hebergeur' : 'des torrents';
    return (
      `La source repond, mais ses resultats sont ${rendus} : sans cle AllDebrid ou ` +
      'TorBox dans la configuration fournie, ils seraient injouables et le fan-out reel ' +
      'ne l interrogerait pas.'
    );
  }
  return 'Source non retenue par le plan de recherche.';
}

/**
 * Recherche par titre, pour remplir le champ de l'essai.
 *
 * Personne ne connait les identifiants IMDb par coeur — et les trackers UNIT3D ne
 * cherchent QUE par identifiant. Sans ça, l'essai etait inutilisable pour eux.
 * Aucune cle : le catalogue de recherche de Cinemeta est public et repond aux titres
 * francais comme anglais.
 */
export async function handleRechercheOeuvre(req: Request, res: Response): Promise<void> {
  const q = String(req.query.q || '').slice(0, 120);
  if (q.trim().length < 2) {
    res.json({ resultats: [] });
    return;
  }
  try {
    res.json({ resultats: await chercherOeuvre(q) });
  } catch (e) {
    res.json({ resultats: [], erreur: (e as Error).message.slice(0, 120) });
  }
}

export async function handleTesterSource(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '');
  const source = allSources().find((s) => s.id === id);
  if (!source) {
    res.status(404).json({ erreur: 'source inconnue' });
    return;
  }

  const corps = (req.body ?? {}) as Record<string, unknown>;
  const saisie = String(corps.titre || 'Squid Game').slice(0, 120);
  const config = parseConfig(segmentDeConfig(String(corps.config || '')) || null);

  // On accepte un TITRE ou un IDENTIFIANT (tt…, tmdb:…, kkh:…), et quand c'en est un,
  // on resout l'identite comme le fait /stream. Sans ça, l'essai n'envoyait qu'un titre
  // — or les trackers UNIT3D ne filtrent que sur imdbId/tmdbId : ils ne construisaient
  // aucune requete et rendaient « 0 candidat » en 0 ms. L'essai doit interroger la
  // source dans les memes conditions que la recherche reelle, sinon il ne prouve rien.
  const identifiant = parseStremioId(saisie);
  const genre: 'movie' | 'series' = identifiant?.season !== undefined ? 'series' : 'movie';
  const oeuvre = identifiant ? await resolveWork(identifiant, genre, config) : null;

  const requete: Query = oeuvre
    ? {
        type: genre,
        titles: oeuvre.titles,
        // Sans lui, l'essai n'interroge pas les sources dans les memes conditions que
        // la recherche reelle : Nyaa, Torznab et DigitalCore ne cherchent alors que
        // sous le titre francais, et rendent zero la ou la vraie recherche trouve.
        titreAnglais: oeuvre.titreAnglais,
        episodesParSaison: oeuvre.episodesParSaison,
        year: oeuvre.year,
        imdbId: oeuvre.imdbId ?? (identifiant?.kind === 'imdb' ? identifiant.value : undefined),
        tmdbId: oeuvre.tmdbId ?? (identifiant?.kind === 'tmdb' ? identifiant.value : undefined),
        kkhId: oeuvre.kkhId ?? (identifiant?.kind === 'kkh' ? identifiant.value : undefined),
        season: identifiant?.season,
        episode: identifiant?.episode,
        originalLanguage: oeuvre.originalLanguage,
      }
    : {
        type: 'series',
        titles: [saisie],
        season: 1,
        episode: 1,
        imdbId: String(corps.imdbId || '') || undefined,
        tmdbId: String(corps.tmdbId || '') || undefined,
      };

  // CE QUE CET ESSAI REPOND : « cette source repond-elle ? ». Pas « cet utilisateur
  // verrait-il quelque chose ? » — c'est le fan-out reel qui tranche ça.
  //
  // La distinction compte. Sans cle de tracker, la source ne peut RIEN chercher : elle
  // rendait une liste vide sans rien tenter, et l'essai affichait « 0 candidat »,
  // exactement comme un tracker joignable qui n'a rien. On concluait qu'elle etait
  // cassee — c'est ce qui est arrive sur DigitalCore. Ce cas-la doit s'annoncer.
  //
  // En revanche, une source desactivee ou dont les resultats seraient injouables faute
  // de debrideur reste parfaitement INTERROGEABLE. L'essayer a du sens, justement pour
  // verifier avant d'activer. On l'interroge donc, en signalant la reserve.
  if (source.requiredUserKey && !config[source.requiredUserKey]) {
    res.json({
      ok: false,
      ignoree: 'cle-absente',
      raison: raisonIgnoree(source, config, 'cle-absente'),
      ms: 0,
      candidats: 0,
    });
    return;
  }

  // Une source qui ne cherche que par identifiant, a qui on n'en donne aucun, ne
  // tentera rien. Le dire vaut mieux que de laisser lire « 0 candidat ».
  if (source.requiertIdentifiant && !requete.imdbId && !requete.tmdbId) {
    res.json({
      ok: false,
      ignoree: 'identifiant-absent',
      raison:
        'Ce tracker ne cherche que par identifiant (son API filtre sur imdbId/tmdbId), ' +
        'jamais par titre. Saisissez un identifiant IMDb — « tt10919420:1:1 » pour un ' +
        'episode, « tt10919420 » pour un film — au lieu du titre.',
      ms: 0,
      candidats: 0,
    });
    return;
  }

  const plan = planSources(config).find((p) => p.source.id === id);
  const reserve = plan?.skip ? raisonIgnoree(source, config, plan.skip) : undefined;

  const deadline = new Deadline(15000);
  const debut = Date.now();
  try {
    const trouves = await source.search(requete, { config, deadline });
    res.json({
      ok: true,
      ms: Date.now() - debut,
      candidats: trouves.length,
      // Ce qui a REELLEMENT ete cherche : un identifiant saisi devient un titre, et
      // c'est utile de le voir pour interpreter le resultat.
      cherche: requete.titles[0],
      // Presente seulement quand la source repond mais ne participerait pas au
      // fan-out reel de cette configuration : l'essai reste concluant, la reserve
      // explique pourquoi l'utilisateur, lui, ne verrait rien.
      reserve,
      exemples: trouves.slice(0, 5).map((c) => ({
        titre: c.title,
        qualite: c.quality,
        langue: c.language,
        taille: c.sizeBytes,
        sources: c.seeders,
      })),
    });
  } catch (e) {
    res.json({ ok: false, ms: Date.now() - debut, erreur: (e as Error).message.slice(0, 200) });
  }
}

/**
 * Sauvegarde complete des reglages OPERATEUR.
 *
 * Elle ne contient aucune cle : celles-ci appartiennent aux utilisateurs et vivent
 * dans leurs liens. Une sauvegarde d'administration qui exfiltrerait des cles serait
 * un piege — on peut la stocker n'importe ou sans y penser.
 */
export function handleExporterSauvegarde(_req: Request, res: Response): void {
  res.setHeader('Content-Disposition', 'attachment; filename="dramallyu-reglages.json"');
  res.json({
    version: 1,
    exporteLe: new Date().toISOString(),
    settings: getSettings(),
    fichiers: listConfigFiles().reduce<Record<string, string>>((acc, f) => {
      acc[f.name] = f.contenu;
      return acc;
    }, {}),
  });
}

export function handleImporterSauvegarde(req: Request, res: Response): void {
  const corps = (req.body ?? {}) as Record<string, unknown>;
  const fichiers = corps.fichiers;
  if (!fichiers || typeof fichiers !== 'object') {
    res.status(400).json({ erreur: 'sauvegarde illisible : « fichiers » manquant' });
    return;
  }

  const ecrits: string[] = [];
  try {
    for (const [nom, contenu] of Object.entries(fichiers as Record<string, string>)) {
      if (!/^[a-z0-9._-]+\.json$/i.test(nom) || nom.includes('..')) continue;
      JSON.parse(contenu); // refus avant ecriture : un JSON casse rendrait l'addon muet
      fs.writeFileSync(path.join(configDir(), nom), contenu, 'utf-8');
      ecrits.push(nom);
    }
    reloadSettings();
    reloadKkeyConfig();
    res.json({ ok: true, ecrits });
  } catch (e) {
    res.status(400).json({ erreur: `import interrompu : ${(e as Error).message}`, ecrits });
  }
}

/**
 * Liens constates morts, avec la possibilite de les oublier.
 *
 * Utile quand un hebergeur remet un fichier en ligne : sans cela il resterait ecarte
 * un mois, et l'operateur n'aurait aucun moyen de le savoir ni de forcer le reessai.
 */
export function handleLiensMorts(_req: Request, res: Response): void {
  const entrees = clesDuPerimetre('liensmorts', 300);
  res.json({
    total: entrees.length,
    liens: entrees.map((e) => ({
      url: e.cle.replace(/^mort:/, ''),
      expire: e.expire,
    })),
  });
}

export function handleOublierLiensMorts(_req: Request, res: Response): void {
  res.json({ ok: true, supprimees: clearScope('liensmorts') });
}

/**
 * Sante des services EXTERNES, verifiee pour de vrai.
 *
 * On interroge chaque adresse et on rapporte ce qu'elle repond. Deux precisions qui
 * changent la lecture du resultat :
 *
 *   - un 401 ou 403 est un SUCCES du point de vue de la disponibilite : le service
 *     repond, il refuse seulement une requete sans cle. Le compter comme une panne
 *     enverrait l'operateur chercher au mauvais endroit ;
 *   - aucune cle d'utilisateur n'est employee. On teste la joignabilite, pas les
 *     acces — ces cles ne nous appartiennent pas.
 */
export async function handleSante(_req: Request, res: Response): Promise<void> {
  const settings = getSettings();
  const cibles: { id: string; url: string }[] = [
    { id: 'cinemeta', url: 'https://v3-cinemeta.strem.io/meta/series/tt10919420.json' },
    { id: 'kisskh', url: `${kisskhBase()}/api/DramaList/Search?q=test&type=0` },
  ];

  for (const [id, conf] of Object.entries(settings.torznab)) {
    if (conf?.url) cibles.push({ id, url: `${conf.url.replace(/\/+$/, '')}?t=caps` });
  }
  for (const [id, conf] of Object.entries(settings.unit3d ?? {})) {
    if (conf?.url) cibles.push({ id, url: `${conf.url.replace(/\/+$/, '')}/api/torrents/filter?perPage=1` });
  }
  if (settings.digitalcore?.url) {
    cibles.push({ id: 'digitalcore', url: `${settings.digitalcore.url.replace(/\/+$/, '')}/api/v1/torrents?searchText=test` });
  }

  const resultats = await Promise.all(
    cibles.map(async (c) => {
      const debut = Date.now();
      try {
        const r = await fetch(c.url, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Dramallyu/1.0 (verification de sante)' },
        });
        return {
          id: c.id,
          statut: r.status,
          ms: Date.now() - debut,
          // Le service repond : c'est tout ce qu'on mesure ici. Un refus
          // d'authentification prouve justement qu'il est vivant.
          joignable: r.status > 0 && r.status < 500,
          note: r.status === 401 || r.status === 403 ? 'repond, exige une cle' : undefined,
        };
      } catch (e) {
        return {
          id: c.id,
          statut: 0,
          ms: Date.now() - debut,
          joignable: false,
          note: (e as Error).name === 'TimeoutError' ? 'delai depasse' : (e as Error).message.slice(0, 80),
        };
      }
    }),
  );

  res.json({ services: resultats.sort((a, b) => Number(a.joignable) - Number(b.joignable)) });
}

/**
 * Activite par INSTALLATION.
 *
 * L'operateur ne detient aucune cle, mais il repond des questions : « pourquoi je ne
 * vois rien ? », « ca marche chez toi ? ». Sans identite, chaque plainte oblige a
 * fouiller un journal global ou toutes les requetes se ressemblent. Avec, on relie une
 * personne a ses traces en un coup d'oeil.
 *
 * On ne rend QUE des compteurs et des titres, jamais une cle : les cles appartiennent
 * aux utilisateurs, et une page d'administration qui les exposerait trahirait la
 * promesse centrale de cet addon.
 */
export function handleUtilisateurs(_req: Request, res: Response): void {
  // DEUX HORIZONS, reunis ici parce qu'ils ne repondent pas a la meme question.
  //
  // Les mesures en memoire disent l'activite DEPUIS LE DEMARRAGE : c'est ce qu'on
  // regarde quand quelque chose se passe maintenant. Elles disparaissent au
  // redeploiement — et on redeploie souvent, ce qui les rendait inutilisables pour un
  // signalement du type « hier soir je n'avais rien ». L'historique persiste repond a
  // celui-la, et lui seul sait trier par nombre d'ennuis recents.
  const vivant = new Map(statsUtilisateurs().map((u) => [u.qui, u]));
  const durables = resumeUtilisateurs();

  const utilisateurs = durables.map((d) => {
    const v = vivant.get(d.qui);
    vivant.delete(d.qui);
    return {
      qui: d.qui,
      requetes: d.requetes,
      vides: d.vides,
      erreurs: d.erreurs,
      horsCreneau: d.horsCreneau,
      soucisRecents: d.soucisRecents,
      premierVu: d.premierVu,
      dernierVu: d.dernierVu,
      msMoyen: d.msMoyen ?? 0,
      // Ce que cette installation a fait depuis le dernier demarrage seulement.
      depuisDemarrage: v ? { requetes: v.requetes, flux: v.flux } : null,
      derniersTitres: v?.derniersTitres ?? [],
    };
  });

  // Une installation vue depuis le demarrage mais absente de la base n'a fait que des
  // requetes non enregistrees (identifiant illisible) : on la montre quand meme, sans
  // quoi les totaux paraitraient faux.
  for (const v of vivant.values()) {
    utilisateurs.push({
      qui: v.qui,
      requetes: v.requetes,
      vides: v.vides,
      erreurs: 0,
      horsCreneau: 0,
      soucisRecents: 0,
      premierVu: v.premierVu,
      dernierVu: v.dernierVu,
      msMoyen: v.msMoyen,
      depuisDemarrage: { requetes: v.requetes, flux: v.flux },
      derniersTitres: v.derniersTitres,
    });
  }

  res.json({
    utilisateurs,
    satures: utilisateursSatures(),
    // Une installation sans identite vient d'un lien anterieur a cette version : le
    // dire evite de croire a un bug quand les compteurs ne totalisent pas.
    sansIdentite: requetesRecentes(200).filter((r) => !r.qui).length,
    tracerTout: getSettings().tracerTout,
  });
}

/**
 * Les recherches d'une installation.
 *
 * L'identifiant passe en parametre de requete, pas dans le chemin : il contient une
 * barre oblique (« pseudo/uid ») que le routeur decouperait en deux segments.
 */
export function handleRequetesUtilisateur(req: Request, res: Response): void {
  const qui = String(req.query.qui || '');
  if (!qui) {
    res.status(400).json({ erreur: 'installation manquante' });
    return;
  }
  res.json({ qui, requetes: requetesDe(qui, Number(req.query.limite) || 40) });
}

/**
 * La trace complete d'une recherche : les lignes de journal qu'ELLE a produites,
 * isolees de celles des autres requetes qui tournaient au meme moment.
 *
 * Elle est demandee a la ligne, jamais servie avec la liste : c'est la seule partie
 * volumineuse, et on n'en lit qu'une a la fois.
 */
export function handleTraceRequete(req: Request, res: Response): void {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ erreur: 'identifiant invalide' });
    return;
  }
  const trace = traceDe(id);
  res.json({
    trace,
    // Distinguer « pas de trace conservee » de « trace vide » : sans ça, l'operateur
    // croit a une panne d'affichage alors que la regle de conservation a joue.
    absente: trace === null,
  });
}

/** Efface l'activite d'une installation. Utile quand quelqu'un le demande. */
export function handleOublierUtilisateur(req: Request, res: Response): void {
  const qui = String((req.body as { qui?: string })?.qui || '');
  if (!qui) {
    res.status(400).json({ erreur: 'installation manquante' });
    return;
  }
  const n = oublier(qui);
  console.log(`[Admin] activite effacee pour ${qui} (${n} ligne(s))`);
  res.json({ ok: true, supprimees: n });
}
