// Signature `kkey` de KissKH. Voir docs/kkey.md pour le reverse complet.
//
// PARTI PRIS : on ne reimplemente PAS leur AES obfusque. On telecharge leur propre
// fonction (8 Ko, dans common.js), on l'evalue dans un bac a sable node:vm, et on
// l'appelle. C'est possible parce que la fonction est PURE quand on lui passe les
// onze arguments — les branches qui liraient window.navigator ne se declenchent que
// sur des arguments `undefined`, et l'application ne laisse jamais ce cas arriver.
//
// Consequence : quand KissKH retouche son algorithme, on recupere la nouvelle version
// automatiquement au lieu de refaire un reverse.
//
// SECURITE RAM : ces fichiers sont du JS minifie sur une seule ligne. Toute recherche
// dedans se fait par indexOf litteral + slice. Une regex a quantificateurs bornes sur
// ce profil de fichier a deja consomme 8 Go.

import * as vm from 'node:vm';
import { getText } from '../../../core/http';
import { makeEndpointConfig } from '../../../core/endpoint-config';

/** Une fonction kkey : onze arguments, rend une signature hexadecimale majuscule. */
type KeyFn = (
  id: number | string,
  nul: null,
  appVer: string,
  guid: string,
  platformVer: number,
  a: string,
  b: string,
  c: string,
  d: string,
  e: string,
  f: string,
) => string;

/** Nombre d'arguments de la fonction de signature — c'est sa signature distinctive. */
const KEY_FN_ARITY = 11;

export interface KkeyConstants {
  base: string;
  appVer: string;
  platformVer: number;
  appName: string;
  viGuid: string;
  subGuid: string;
}

// Valeurs relevees le 2026-08-12. Elles servent de point de depart : la re-decouverte
// les remplace automatiquement en cas de 403, et l'operateur peut les forcer a chaud
// via config/kisskh-kkey.json.
const endpoints = makeEndpointConfig<Record<string, unknown>>(
  'kisskh-kkey.json',
  'KISSKH_KKEY_CONFIG',
  {
    base: 'https://kisskh.co',
    appVer: '2.8.10',
    platformVer: 4830201,
    appName: 'kisskh',
    viGuid: '62f176f3bb1b5b8e70e39932ad34a0c7',
    subGuid: 'VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp',
  },
);

export const reloadKkeyConfig = endpoints.reload;

export function constants(): KkeyConstants {
  const c = endpoints.get();
  return {
    base: String(c.base || 'https://kisskh.co').replace(/\/+$/, ''),
    appVer: String(c.appVer || '2.8.10'),
    platformVer: Number(c.platformVer) || 4830201,
    appName: String(c.appName || 'kisskh'),
    viGuid: String(c.viGuid || ''),
    subGuid: String(c.subGuid || ''),
  };
}

const FN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SCRIPT_BYTES = 700 * 1024;

let cachedFn: KeyFn | null = null;
let cachedAt = 0;
let discovering: Promise<KeyFn | null> | null = null;

/** Extrait les `src=` d'un HTML par balayage litteral (pas d'automate). */
function scriptSources(html: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = html.indexOf('src=', i)) !== -1) {
    const quote = html[i + 4];
    if (quote !== '"' && quote !== "'") {
      i += 4;
      continue;
    }
    const end = html.indexOf(quote, i + 5);
    if (end === -1) break;
    out.push(html.slice(i + 5, end));
    i = end + 1;
  }
  return out;
}

function absolute(base: string, src: string): string {
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  if (src.startsWith('//')) return 'https:' + src;
  return `${base}/${src.replace(/^\.?\//, '')}`;
}

/**
 * Evalue un script et cherche dedans la fonction de signature.
 *
 * On l'identifie par son ARITE (onze parametres) plutot que par son nom : le nom est
 * genere par l'obfuscateur (`_0x54b991` aujourd'hui) et changera au prochain build,
 * alors que le nombre d'arguments est impose par l'appelant Angular.
 */
function extractKeyFn(source: string): KeyFn | null {
  const sandbox: Record<string, unknown> = {
    // Stubs minimaux : la fonction ne les touche pas quand on lui passe les onze
    // arguments, mais le script fait d'autres choses au chargement.
    window: { navigator: {}, document: {} },
    navigator: {},
    document: {},
    console: { log: () => {}, error: () => {}, warn: () => {} },
  };
  sandbox.window = sandbox.window as object;
  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(source, context, { timeout: 5000 });
  } catch {
    // Un script qui echoue au chargement (dependance absente du bac a sable) peut
    // quand meme avoir defini ce qu'on cherche avant de casser : on continue.
  }

  const candidates: KeyFn[] = [];
  for (const name of Object.getOwnPropertyNames(sandbox)) {
    if (name === 'window' || name === 'navigator' || name === 'document') continue;
    const value = (sandbox as Record<string, unknown>)[name];
    if (typeof value === 'function' && value.length === KEY_FN_ARITY) {
      candidates.push(value as KeyFn);
    }
  }
  if (candidates.length !== 1) return null;

  // Validation : la vraie fonction rend un hexadecimal majuscule, multiple de 32
  // caracteres (blocs AES). Un faux positif d'arite serait ecarte ici.
  const probe = candidates[0];
  try {
    const out = probe(1, null, '2.8.10', 'x'.repeat(32), 1, 'k', 'k', 'k', 'k', 'k', 'k');
    if (typeof out !== 'string' || out.length < 32 || out.length % 32 !== 0) return null;
    if (!/^[0-9A-F]+$/.test(out)) return null;
  } catch {
    return null;
  }
  return probe;
}

/** Telecharge la page d'accueil et essaie chaque script « leger » jusqu'a trouver. */
async function discoverKeyFn(): Promise<KeyFn | null> {
  const base = constants().base;
  const html = await getText(`${base}/`, { timeoutMs: 20000 });
  if (!html) {
    console.log('[KissKH] page d\'accueil injoignable — kkey indisponible');
    return null;
  }

  const scripts = scriptSources(html)
    .filter((s) => s.endsWith('.js') || s.includes('.js?'))
    // Le bundle principal, les polyfills et le runtime ne portent pas la fonction :
    // elle vit dans un script classique (common.js). On les ecarte pour ne pas
    // telecharger 1,2 Mo pour rien.
    .filter((s) => !s.includes('main.') && !s.includes('polyfills.') && !s.includes('runtime.'))
    .filter((s) => !s.includes('cloudflare') && !s.includes('accounts.google'))
    .map((s) => absolute(base, s));

  for (const url of [...new Set(scripts)]) {
    const src = await getText(url, { timeoutMs: 20000, maxBytes: MAX_SCRIPT_BYTES });
    if (!src) continue;
    const fn = extractKeyFn(src);
    if (fn) {
      console.log(`[KissKH] fonction kkey trouvee dans ${url.split('/').pop()}`);
      return fn;
    }
  }
  console.log('[KissKH] aucune fonction kkey trouvee dans les scripts de la page');
  return null;
}

/** Fonction courante, telechargee au besoin. Les appels concurrents partagent l'attente. */
async function keyFn(): Promise<KeyFn | null> {
  if (cachedFn && Date.now() - cachedAt < FN_TTL_MS) return cachedFn;
  if (discovering) return discovering;

  discovering = discoverKeyFn()
    .then((fn) => {
      if (fn) {
        cachedFn = fn;
        cachedAt = Date.now();
      }
      return fn;
    })
    .finally(() => {
      discovering = null;
    });
  return discovering;
}

async function sign(episodeId: number, guid: string): Promise<string | null> {
  const fn = await keyFn();
  if (!fn) return null;
  const c = constants();
  if (!guid) return null;
  try {
    return fn(
      episodeId,
      null,
      c.appVer,
      guid,
      c.platformVer,
      c.appName,
      c.appName,
      c.appName,
      c.appName,
      c.appName,
      c.appName,
    );
  } catch (e) {
    console.log(`[KissKH] echec de signature: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
}

/** Signature pour l'endpoint video (`DramaList/Episode/<id>.png`). */
export function videoKey(episodeId: number): Promise<string | null> {
  return sign(episodeId, constants().viGuid);
}

/** Signature pour l'endpoint sous-titres (`Sub/<id>`). */
export function subKey(episodeId: number): Promise<string | null> {
  return sign(episodeId, constants().subGuid);
}

// --- Auto-reparation ---------------------------------------------------------
//
// Un 403 isole peut etre du bruit (rate-limit Cloudflare, episode retire). Une SALVE
// signifie que la signature ne passe plus : c'est la que la re-decouverte se justifie.
// On evite ainsi de retelecharger leurs bundles a chaque hoquet.

const FORBIDDEN_THRESHOLD = 3;
const FORBIDDEN_WINDOW_MS = 5 * 60 * 1000;
const REDISCOVER_COOLDOWN_MS = 15 * 60 * 1000;

let forbiddenTimes: number[] = [];
let lastRediscover = 0;

/** A appeler sur chaque 403 des endpoints signes. */
export function noteForbidden(): void {
  const now = Date.now();
  forbiddenTimes = forbiddenTimes.filter((t) => now - t < FORBIDDEN_WINDOW_MS);
  forbiddenTimes.push(now);
  if (forbiddenTimes.length < FORBIDDEN_THRESHOLD) return;
  if (now - lastRediscover < REDISCOVER_COOLDOWN_MS) return;

  lastRediscover = now;
  forbiddenTimes = [];
  console.log('[KissKH] salve de 403 — re-decouverte de la signature');
  cachedFn = null;
  cachedAt = 0;
  void rediscoverConstants();
}

/**
 * Re-extrait les constantes (guids, versions) depuis les chunks du site.
 *
 * Elles vivent dans le chunk du lecteur, dont le nom change a chaque build. On lit la
 * table des chunks dans runtime.js (3 Ko, donc une regex y est sans danger), puis on
 * cherche `subGuid="` par indexOf dans chaque chunk — jamais par regex, ces fichiers
 * montent a plusieurs centaines de Ko sur une seule ligne.
 */
export async function rediscoverConstants(): Promise<Partial<KkeyConstants> | null> {
  // CHAQUE ECHEC SE NOMME. Cette fonction avait cinq sorties nulles muettes, et
  // l'administration affichait toujours « aucune fonction exploitable trouvee » —
  // un message faux dans quatre cas sur cinq. Un hebergeur voyait donc « echec »
  // sans savoir que son fournisseur n'atteignait tout simplement pas le site.
  const base = constants().base;
  const html = await getText(`${base}/`, { timeoutMs: 20000 });
  if (!html) {
    console.error(
      `[KissKH] re-decouverte : ${base} injoignable depuis cet hebergeur. ` +
        'Certains hebergeurs voient leurs adresses bloquees par le site.',
    );
    return null;
  }

  const runtimeSrc = scriptSources(html).find((s) => s.includes('runtime.'));
  if (!runtimeSrc) {
    console.error("[KissKH] re-decouverte : page recue, mais aucun script `runtime.` — le site a change de forme.");
    return null;
  }
  const runtime = await getText(absolute(base, runtimeSrc), { timeoutMs: 20000 });
  if (!runtime) {
    console.error('[KissKH] re-decouverte : le script runtime n a pas pu etre telecharge.');
    return null;
  }

  // runtime.js fait ~3,7 Ko : une regex simple y est sans risque.
  const chunkNames: string[] = [];
  for (const m of runtime.matchAll(/(\d{2,4}):"([0-9a-f]{8,32})"/g)) {
    chunkNames.push(`${m[1]}.${m[2]}.js`);
  }
  if (chunkNames.length === 0) {
    console.error("[KissKH] re-decouverte : aucun fragment de script listé dans runtime — forme inattendue.");
    return null;
  }

  for (const name of chunkNames) {
    const src = await getText(`${base}/${name}`, { timeoutMs: 25000, maxBytes: MAX_SCRIPT_BYTES });
    if (!src) continue;
    const at = src.indexOf('subGuid');
    if (at === -1) continue;

    // Fenetre etroite autour de la declaration : les six constantes sont declarees
    // a la suite dans le constructeur du composant lecteur.
    const window_ = src.slice(Math.max(0, at - 200), at + 400);
    const found: Partial<KkeyConstants> = {};
    const pick = (label: string): string | undefined => {
      const k = window_.indexOf(`${label}="`);
      if (k === -1) return undefined;
      const start = k + label.length + 2;
      const end = window_.indexOf('"', start);
      return end === -1 ? undefined : window_.slice(start, end);
    };
    found.subGuid = pick('subGuid');
    found.viGuid = pick('viGuid');
    found.appVer = pick('appVer');
    found.appName = pick('appName');
    const pv = window_.indexOf('platformVer=');
    if (pv !== -1) {
      const digits = window_.slice(pv + 12, pv + 24).match(/^\d+/);
      if (digits) found.platformVer = Number(digits[0]);
    }

    if (found.subGuid && found.viGuid) {
      console.log(
        `[KissKH] constantes re-extraites depuis ${name} (appVer=${found.appVer}, platformVer=${found.platformVer})`,
      );
      // Applique a chaud, en memoire. L'operateur peut figer ces valeurs dans
      // config/kisskh-kkey.json si besoin.
      Object.assign(endpoints.get(), found);
      return found;
    }
  }
  console.log('[KissKH] re-extraction des constantes infructueuse');
  return null;
}

/** Etat pour la page admin. */
export function kkeyStatus(): { fnLoaded: boolean; ageMs: number | null; constants: KkeyConstants } {
  return {
    fnLoaded: cachedFn !== null,
    ageMs: cachedAt ? Date.now() - cachedAt : null,
    constants: constants(),
  };
}
