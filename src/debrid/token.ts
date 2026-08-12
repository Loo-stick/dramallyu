// Jetons de lecture signes.
//
// La reponse /stream ne debride RIEN : chaque entree pointe vers /resolve/<jeton>,
// et le debridage n'a lieu qu'au moment ou l'utilisateur appuie sur Play. C'est ce
// qui tient le budget de 8 s, et ca evite d'ajouter chez le debrideur des dizaines de
// magnets que personne ne regardera.
//
// Le jeton porte donc tout ce qu'il faut pour resoudre plus tard, y compris la CLE
// DEBRID de l'utilisateur — puisque l'addon ne stocke aucun etat par utilisateur.
// Il est signe en HMAC pour qu'on ne puisse pas le fabriquer, et il expire.

import * as crypto from 'node:crypto';

export interface ResolvePayload {
  /** 'torrent' ou 'ddl'. */
  k: 'torrent' | 'ddl';
  /** Hash du torrent, ou URL du lien DDL. */
  v: string;
  /** Nom de fichier vise dans un torrent multi-fichiers. */
  f?: string;
  /** Cle AllDebrid de l'utilisateur. */
  ad?: string;
  /** Cle TorBox de l'utilisateur. */
  tb?: string;
  /** Expiration (epoch ms). */
  exp: number;
}

const TTL_MS = 12 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.TOKEN_SECRET;
  if (s && s.length >= 16) return s;
  // Un secret ephemere vaut mieux qu'un secret vide : les jetons deviennent invalides
  // au redemarrage (l'utilisateur relance la lecture), mais ils restent infalsifiables.
  if (!fallbackSecret) {
    fallbackSecret = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[Jetons] TOKEN_SECRET absent du .env — secret ephemere genere. ' +
        'Les liens de lecture seront invalides apres chaque redemarrage.',
    );
  }
  return fallbackSecret;
}
let fallbackSecret: string | null = null;

function sign(data: string): string {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url').slice(0, 32);
}

export function encodeToken(payload: Omit<ResolvePayload, 'exp'>): string {
  const full: ResolvePayload = { ...payload, exp: Date.now() + TTL_MS };
  const body = Buffer.from(JSON.stringify(full), 'utf-8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodeToken(token: string): ResolvePayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = sign(body);
  // Comparaison a temps constant : une comparaison naive laisse fuir la signature
  // octet par octet.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as ResolvePayload;
    if (!payload || typeof payload.v !== 'string') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
