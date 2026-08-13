// Jetons de lecture CHIFFRES.
//
// La reponse /stream ne debride RIEN : chaque entree pointe vers /resolve/<jeton>,
// et le debridage n'a lieu qu'au moment ou l'utilisateur appuie sur Play. C'est ce
// qui tient le budget de 8 s, et ca evite d'ajouter chez le debrideur des dizaines de
// magnets que personne ne regardera.
//
// Le jeton porte donc tout ce qu'il faut pour resoudre plus tard, y compris la CLE
// DEBRID de l'utilisateur — puisque l'addon ne stocke aucun etat par utilisateur.
// Il est donc chiffre (AES-256-GCM), et pas seulement signe : ces URL sont remises au
// lecteur, elles finissent dans les journaux et les captures d ecran.

import * as crypto from 'node:crypto';
import { chiffrer, dechiffrer } from '../core/crypto';

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
  /**
   * Lien vers le .torrent. Il ne sert QU'AU PLAY, et seulement si le hash n'a rien
   * donne : la verification de disponibilite, elle, continue d'envoyer des hashes nus
   * par lots — deposer des fichiers pour simplement regarder ce qui est pret serait
   * hors de proportion.
   */
  t?: string;
  /** Preference de debrideur, pour que le Play respecte le reglage. */
  pref?: 'auto' | 'alldebrid' | 'torbox';
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

/**
 * Le jeton est CHIFFRE, pas seulement signe.
 *
 * Il l'etait auparavant : base64 du contenu, suivi d'un HMAC. La signature empechait
 * de le fabriquer, mais absolument pas de le LIRE — et ce contenu porte les cles
 * debrid. Or ces URL sont remises au lecteur : elles atterrissent dans les journaux
 * d'un proxy, dans une capture d'ecran, dans AIOStreams. Quiconque en voyait une
 * recuperait les cles en decodant du base64.
 *
 * AES-256-GCM regle les deux a la fois : illisible, et authentifie — donc toujours
 * infalsifiable, la signature separee n'a plus lieu d'etre.
 *
 * Consequence assumee : les jetons emis avant ce changement ne sont plus valides.
 * Ils vivaient douze heures ; rouvrir la fiche suffit a en obtenir de nouveaux.
 */
export function encodeToken(payload: Omit<ResolvePayload, 'exp'>): string {
  const full: ResolvePayload = { ...payload, exp: Date.now() + TTL_MS };
  const chiffre = chiffrer(full);
  if (chiffre) return chiffre;

  // Sans TOKEN_SECRET, le chiffrement est impossible. On signe alors un contenu SANS
  // aucune cle : le flux devient injouable, mais rien ne fuit. Mieux vaut un lien
  // mort qu'un lien qui distribue les cles de l'utilisateur.
  const sansCles: ResolvePayload = { ...full, ad: undefined, tb: undefined };
  const body = Buffer.from(JSON.stringify(sansCles), 'utf-8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodeToken(token: string): ResolvePayload | null {
  const clair = dechiffrer(token) as ResolvePayload | null;
  if (clair) {
    if (typeof clair.v !== 'string') return null;
    if (typeof clair.exp !== 'number' || clair.exp < Date.now()) return null;
    return clair;
  }

  // Repli signe (instance sans TOKEN_SECRET). Il ne transporte jamais de cle.
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
