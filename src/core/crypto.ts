// Chiffrement de la configuration utilisateur.
//
// CE QUE CA REGLE, ET CE QUE CA NE REGLE PAS — la nuance compte, et la page
// /configure doit la dire telle quelle :
//
//   Ca NE rend PAS le lien partageable. Qui detient le lien peut toujours lire des
//   flux a travers le compte debrid de son proprietaire : c'est le serveur qui
//   dechiffre et qui utilise les cles. Le lien reste un jeton « au porteur ».
//
//   Ca EMPECHE l'EXTRACTION des cles. Et ce n'est pas theorique : un lien
//   d'installation colle dans un salon Discord pour demander de l'aide, c'est,
//   en base64, une cle AllDebrid reutilisable n'importe ou, decodable en trois
//   secondes. Chiffree, elle ne sort pas de cette instance.
//
// AES-256-GCM : le chiffrement authentifie garantit aussi qu'on ne peut pas bricoler
// le contenu (echanger une cle, gonfler maxResults) sans que le dechiffrement echoue.
//
// La cle derive de TOKEN_SECRET. Consequence a assumer : changer TOKEN_SECRET invalide
// tous les liens d'installation existants. C'est documente dans .env.example.

import * as crypto from 'node:crypto';

/** Marqueur de version en tete du blob : permet de faire evoluer le format. */
const PREFIXE = 'e1';
const SEL = 'dramallyu-config-v1';
const TAILLE_IV = 12;
const TAILLE_TAG = 16;

let cleCache: Buffer | null = null;
let secretUtilise: string | null = null;

function cle(): Buffer | null {
  const secret = (process.env.TOKEN_SECRET || '').trim();
  if (secret.length < 16) return null;
  if (cleCache && secretUtilise === secret) return cleCache;

  // scrypt : deriver plutot que d'utiliser TOKEN_SECRET brut, pour que la meme
  // valeur puisse servir a plusieurs usages (jetons, session admin) sans les lier.
  cleCache = crypto.scryptSync(secret, SEL, 32);
  secretUtilise = secret;
  return cleCache;
}

/** Le chiffrement est-il possible sur cette instance ? */
export function chiffrementDisponible(): boolean {
  return cle() !== null;
}

/**
 * Chiffre un objet de configuration.
 * Rend null si TOKEN_SECRET est absent — l'appelant retombe alors sur le base64 clair
 * plutot que de refuser de servir.
 */
export function chiffrer(donnees: unknown): string | null {
  const k = cle();
  if (!k) return null;

  const iv = crypto.randomBytes(TAILLE_IV);
  const chiffreur = crypto.createCipheriv('aes-256-gcm', k, iv);
  const corps = Buffer.concat([
    chiffreur.update(JSON.stringify(donnees), 'utf-8'),
    chiffreur.final(),
  ]);
  const tag = chiffreur.getAuthTag();

  return `${PREFIXE}.${Buffer.concat([iv, tag, corps]).toString('base64url')}`;
}

/** Le segment ressemble-t-il a une configuration chiffree ? */
export function estChiffre(segment: string): boolean {
  return segment.startsWith(`${PREFIXE}.`);
}

/**
 * Dechiffre. Rend null sur tout probleme — secret absent, blob tronque, contenu
 * altere. Un echec doit rester silencieux et retomber sur les valeurs par defaut :
 * une requete Stremio ne doit jamais echouer a cause d'une config illisible.
 */
export function dechiffrer(segment: string): unknown | null {
  const k = cle();
  if (!k || !estChiffre(segment)) return null;

  try {
    const brut = Buffer.from(segment.slice(PREFIXE.length + 1), 'base64url');
    if (brut.length <= TAILLE_IV + TAILLE_TAG) return null;

    const iv = brut.subarray(0, TAILLE_IV);
    const tag = brut.subarray(TAILLE_IV, TAILLE_IV + TAILLE_TAG);
    const corps = brut.subarray(TAILLE_IV + TAILLE_TAG);

    const dechiffreur = crypto.createDecipheriv('aes-256-gcm', k, iv);
    dechiffreur.setAuthTag(tag);
    const clair = Buffer.concat([dechiffreur.update(corps), dechiffreur.final()]);
    return JSON.parse(clair.toString('utf-8'));
  } catch {
    return null;
  }
}
