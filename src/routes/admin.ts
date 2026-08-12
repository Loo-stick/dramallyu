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
import { clearAll, clearScope, getCacheStats } from '../core/cache';
import { allSources } from '../core/registry';
import { kkeyStatus, rediscoverConstants, reloadKkeyConfig } from '../sources/direct/kisskh/kkey';

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

export async function handleRediscoverKkey(_req: Request, res: Response): Promise<void> {
  const found = await rediscoverConstants();
  res.json({ ok: Boolean(found), constantes: found, etat: kkeyStatus() });
}
