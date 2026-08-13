// AllDebrid (API v4). Porte depuis wastream et stream-fusion.
//
// DEUX PARTICULARITES A NE PAS OUBLIER :
//
//  1. Il n'y a plus d'API d'instant-availability exploitable. `checkCached` rend donc
//     une carte VIDE — « je ne sais pas » — et l'interface l'affiche honnetement.
//     La reponse de /magnet/upload porte bien un champ `ready`, mais PAS de
//     `statusCode` : ce dernier n'existe que dans /magnet/status. Les confondre est
//     un piege documente dans stream-fusion.
//  2. C'est AllDebrid qui debloque les liens d'hebergeur (1fichier, uptobox) via
//     /link/unlock — c'est ce qui fait vivre tout le pilier DDL.

import axios from 'axios';
import type { DebridFile, DebridService } from './types';
import { extractHash, pickFile, toMagnet } from './types';

const BASE = 'https://api.alldebrid.com/v4';
const AGENT = 'dramallyu';
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 1500;

interface AdResponse<T> {
  status?: string;
  data?: T;
  error?: { code?: string; message?: string };
}

async function call<T>(
  path: string,
  apiKey: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T | null> {
  const qs = new URLSearchParams({ agent: AGENT, ...params }).toString();
  try {
    const res = await axios.get<AdResponse<T>>(`${BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 20000,
      validateStatus: () => true,
      signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const body = res.data;
    if (!body || body.status === 'error') {
      if (body?.error) {
        console.log(`[AllDebrid] ${path}: ${body.error.code} ${body.error.message ?? ''}`);
      }
      return null;
    }
    return (body.data ?? null) as T | null;
  } catch (e) {
    console.log(`[AllDebrid] ${path}: ${(e as Error).message.slice(0, 90)}`);
    return null;
  }
}

/**
 * Redirecteurs employes par les sites DDL francais. Ils ne servent pas un fichier :
 * ils masquent le lien d'hebergeur derriere une page intermediaire.
 */
const REDIRECTORS = ['dl-protect', 'zoneurs', 'protect-link', 'dlprotect', 'rapidsafe'];

export function isRedirector(url: string): boolean {
  const bas = url.toLowerCase();
  return REDIRECTORS.some((r) => bas.includes(r));
}

interface UploadedMagnet {
  id?: number;
  hash?: string;
  ready?: boolean;
  error?: { code?: string };
}

async function uploadMagnet(
  magnetOrHash: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const data = await call<{ magnets?: UploadedMagnet[] }>(
    '/magnet/upload',
    apiKey,
    { 'magnets[]': toMagnet(magnetOrHash) },
    signal,
  );
  const first = data?.magnets?.[0];
  return first?.id ?? null;
}

interface MagnetStatus {
  status?: string;
  statusCode?: number;
  links?: { link: string; filename: string; size?: number }[];
}

async function magnetStatus(
  id: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<MagnetStatus | null> {
  const data = await call<{ magnets?: MagnetStatus | MagnetStatus[] }>(
    '/magnet/status',
    apiKey,
    { id: String(id) },
    signal,
  );
  const m = data?.magnets;
  if (!m) return null;
  return Array.isArray(m) ? (m[0] ?? null) : m;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Attend que le magnet soit pret. Un torrent deja en cache repond « Ready » au premier
 * tour ; sinon on patiente brievement puis on abandonne — l'utilisateur relancera. Il
 * ne faut PAS boucler longtemps ici : on est sur le chemin du Play, pas en tache de
 * fond.
 */
async function waitReady(
  id: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<MagnetStatus | null> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const st = await magnetStatus(id, apiKey, signal);
    if (st?.statusCode === 4 || /ready/i.test(st?.status || '')) return st;
    // 5 et au-dela = erreur definitive (upload impossible, fichier absent).
    if (typeof st?.statusCode === 'number' && st.statusCode >= 5) return null;
    if (signal?.aborted) return null;
    await sleep(POLL_DELAY_MS);
  }
  return null;
}

async function filesOf(
  magnetOrHash: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<DebridFile[]> {
  const id = await uploadMagnet(magnetOrHash, apiKey, signal);
  if (id === null) return [];
  const status = await waitReady(id, apiKey, signal);
  if (!status?.links) return [];
  return status.links.map((l) => ({ name: l.filename, sizeBytes: l.size, link: l.link }));
}

export function allDebrid(apiKey: string): DebridService {
  return {
    name: 'alldebrid',
    supportsCacheCheck: false,

    async checkCached(): Promise<Map<string, boolean>> {
      // Volontairement vide : mieux vaut ne rien affirmer que d'afficher un
      // « instantane » que le premier clic dementira.
      return new Map();
    },

    async resolveTorrent(magnetOrHash, fileHint, signal) {
      const files = await filesOf(magnetOrHash, apiKey, signal);
      const picked = pickFile(files, fileHint);
      if (!picked?.link) return null;
      // Les liens de /magnet/status sont des liens AllDebrid, pas encore des liens
      // de telechargement : il faut les passer par /link/unlock.
      return this.resolveDdl(picked.link, signal);
    },

    async resolveDdl(link, signal) {
      // Les sites DDL francais ne publient jamais le lien d'hebergeur en clair : il
      // est derriere un REDIRECTEUR (dl-protect pour Wawacity, zoneurs pour
      // Zone-Telechargement). Passer ce lien directement a /link/unlock echoue —
      // AllDebrid a un endpoint dedie pour ca, qu'il faut appeler d'abord.
      let cible = link;
      if (isRedirector(link)) {
        const redir = await call<{ links?: string[] }>('/link/redirector', apiKey, { link }, signal);
        const premier = redir?.links?.find((l) => typeof l === 'string' && /^https?:\/\//.test(l));
        if (!premier) return null;
        cible = premier;
      }

      const data = await call<{ link?: string }>('/link/unlock', apiKey, { link: cible }, signal);
      return data?.link ?? null;
    },

    async listFiles(magnetOrHash, signal) {
      return filesOf(magnetOrHash, apiKey, signal);
    },
  };
}

export { extractHash };
