// Client HTTP unique du projet. Toute source passe par ici pour trois raisons :
// un budget de temps respecte (le fan-out impose une deadline dure), une politique
// de retry unique, et des en-tetes de navigateur credibles.
//
// La politique de retry est reprise de wastream (debrid/base.py) : on ne rejoue que
// les codes qui traduisent une indisponibilite passagere. Rejouer un 403 ou un 404
// ne fait que doubler la charge sur une source qui a deja repondu clairement.

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

export const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Deadline du fan-out : coupe la requete des que le budget global est epuise. */
  signal?: AbortSignal;
  retries?: number;
  params?: Record<string, string | number | undefined>;
  responseType?: 'json' | 'text';
  maxRedirects?: number;
  /** Taille maximale acceptee. Garde-fou RAM : un gros corps inattendu est refuse. */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * GET avec retry. Renvoie la reponse meme en cas de statut d'erreur (validateStatus
 * est neutralise) : c'est a l'appelant de decider ce qu'un 403 signifie pour lui —
 * pour KissKH, par exemple, un 403 declenche la re-extraction du kkey.
 */
export async function httpGet<T = unknown>(
  url: string,
  opts: HttpOptions = {},
): Promise<AxiosResponse<T> | null> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const cfg: AxiosRequestConfig = {
    headers: { ...BROWSER_HEADERS, ...opts.headers },
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    validateStatus: () => true,
    maxRedirects: opts.maxRedirects ?? 4,
    maxContentLength: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    maxBodyLength: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    decompress: true,
    params: opts.params,
    signal: opts.signal,
  };
  if (opts.responseType === 'text') {
    cfg.responseType = 'text';
    // transformResponse neutralise : axios essaie sinon de parser du JSON dans du
    // HTML et renvoie un objet inattendu.
    cfg.transformResponse = [(v) => v];
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) return null;
    try {
      const res = await axios.get<T>(url, cfg);
      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        await sleep(400 * (attempt + 1), opts.signal);
        continue;
      }
      return res;
    } catch (e) {
      // Abort = budget epuise : on ne rejoue pas, ce serait travailler pour rien.
      if (opts.signal?.aborted) return null;
      if (attempt >= retries) {
        console.log(`[HTTP] ${shortUrl(url)} — ${(e as Error).message.slice(0, 100)}`);
        return null;
      }
      await sleep(400 * (attempt + 1), opts.signal);
    }
  }
  return null;
}

/** GET JSON : renvoie null sur toute reponse non-2xx ou non exploitable. */
export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T | null> {
  const res = await httpGet<T>(url, opts);
  if (!res || res.status < 200 || res.status >= 300) return null;
  return res.data ?? null;
}

/** GET texte/HTML : renvoie null sur toute reponse non-2xx. */
export async function getText(url: string, opts: HttpOptions = {}): Promise<string | null> {
  const res = await httpGet<string>(url, { ...opts, responseType: 'text' });
  if (!res || res.status < 200 || res.status >= 400) return null;
  return typeof res.data === 'string' ? res.data : null;
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  opts: HttpOptions = {},
): Promise<T | null> {
  try {
    const res = await axios.post<T>(url, body, {
      headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS, ...opts.headers },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      signal: opts.signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    return res.data ?? null;
  } catch {
    return null;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.slice(0, 40);
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Deadline partagee par tout un fan-out. `AbortSignal.timeout` seul ne suffit pas :
 * on veut aussi pouvoir constater le temps restant pour decider d'engager, ou non,
 * une source connue pour etre lente.
 */
export class Deadline {
  private readonly endsAt: number;
  readonly signal: AbortSignal;

  constructor(budgetMs: number) {
    this.endsAt = Date.now() + budgetMs;
    this.signal = AbortSignal.timeout(budgetMs);
  }

  remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }
}
