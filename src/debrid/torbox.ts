// TorBox (API v1).
//
// Contrairement a AllDebrid, TorBox expose un check-cache PAR LOT
// (`/torrents/checkcached`) : une seule requete pour tous les hashes d'une reponse.
// C'est ce qui permet d'afficher honnetement « instantane » — et c'est assez rapide
// pour tenir dans le budget de /stream.

import axios from 'axios';
import type { DebridFile, DebridService } from './types';
import { extractHash, pickFile, toMagnet } from './types';

const BASE = 'https://api.torbox.app/v1/api';
const CACHE_BATCH = 100;
const POLL_ATTEMPTS = 6;
const POLL_DELAY_MS = 1500;

interface TbResponse<T> {
  success?: boolean;
  detail?: string;
  data?: T;
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function tbGet<T>(
  path: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const res = await axios.get<TbResponse<T>>(`${BASE}${path}`, {
      headers: headers(apiKey),
      timeout: 20000,
      validateStatus: () => true,
      signal,
    });
    if (res.status < 200 || res.status >= 300 || !res.data?.success) return null;
    return (res.data.data ?? null) as T | null;
  } catch (e) {
    console.log(`[TorBox] ${path}: ${(e as Error).message.slice(0, 90)}`);
    return null;
  }
}

async function tbPost<T>(
  path: string,
  apiKey: string,
  body: unknown,
  form = false,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const payload = form ? new URLSearchParams(body as Record<string, string>) : body;
    const res = await axios.post<TbResponse<T>>(`${BASE}${path}`, payload, {
      headers: {
        ...headers(apiKey),
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      timeout: 25000,
      validateStatus: () => true,
      signal,
    });
    if (res.status < 200 || res.status >= 300 || !res.data?.success) return null;
    return (res.data.data ?? null) as T | null;
  } catch (e) {
    console.log(`[TorBox] ${path}: ${(e as Error).message.slice(0, 90)}`);
    return null;
  }
}

interface TbTorrent {
  id: number;
  hash?: string;
  download_finished?: boolean;
  download_present?: boolean;
  files?: { id: number; name: string; short_name?: string; size?: number }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function findExisting(
  hash: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<TbTorrent | null> {
  const list = await tbGet<TbTorrent[]>('/torrents/mylist?bypass_cache=true', apiKey, signal);
  if (!Array.isArray(list)) return null;
  return list.find((t) => (t.hash || '').toLowerCase() === hash) ?? null;
}

async function addAndWait(
  magnetOrHash: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<TbTorrent | null> {
  const hash = extractHash(magnetOrHash);
  if (!hash) return null;

  // Deja dans la bibliotheque de l'utilisateur : inutile de le rajouter, et ca evite
  // de polluer son compte a chaque lecture.
  const existing = await findExisting(hash, apiKey, signal);
  if (existing?.download_finished || existing?.download_present) return existing;

  const created = await tbPost<{ torrent_id?: number }>(
    '/torrents/createtorrent',
    apiKey,
    { magnet: toMagnet(magnetOrHash), seed: '3', allow_zip: 'false' },
    true,
    signal,
  );
  const id = created?.torrent_id ?? existing?.id;
  if (id === undefined) return null;

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const info = await tbGet<TbTorrent | TbTorrent[]>(
      `/torrents/mylist?bypass_cache=true&id=${id}`,
      apiKey,
      signal,
    );
    const t = Array.isArray(info) ? info[0] : info;
    if (t && (t.download_finished || t.download_present)) return t;
    if (signal?.aborted) return null;
    await sleep(POLL_DELAY_MS);
  }
  return null;
}

function toFiles(t: TbTorrent): DebridFile[] {
  return (t.files ?? []).map((f) => ({
    name: f.short_name || f.name,
    sizeBytes: f.size,
    id: f.id,
  }));
}

export function torbox(apiKey: string): DebridService {
  return {
    name: 'torbox',
    supportsCacheCheck: true,

    async checkCached(hashes, signal) {
      const out = new Map<string, boolean>();
      const clean = [...new Set(hashes.map((h) => h.toLowerCase()).filter((h) => /^[a-f0-9]{40}$/.test(h)))];

      for (let i = 0; i < clean.length; i += CACHE_BATCH) {
        const batch = clean.slice(i, i + CACHE_BATCH);
        const data = await tbPost<{ hash?: string }[] | Record<string, unknown>>(
          '/torrents/checkcached?format=list&list_files=false',
          apiKey,
          { hashes: batch },
          false,
          signal,
        );
        if (Array.isArray(data)) {
          for (const item of data) {
            const h = String(item?.hash || '').toLowerCase();
            if (h) out.set(h, true);
          }
        } else if (data && typeof data === 'object') {
          for (const h of Object.keys(data)) out.set(h.toLowerCase(), true);
        }
      }
      // Un hash absent de la reponse est non-cache : on le dit explicitement, sinon
      // l'appelant ne saurait pas distinguer « absent » de « pas interroge ».
      for (const h of clean) if (!out.has(h)) out.set(h, false);
      return out;
    },

    async resolveTorrent(magnetOrHash, fileHint, signal) {
      const t = await addAndWait(magnetOrHash, apiKey, signal);
      if (!t) return null;
      const picked = pickFile(toFiles(t), fileHint);
      if (!picked || picked.id === undefined) return null;

      const dl = await tbGet<{ url?: string } | string>(
        `/torrents/requestdl?token=${encodeURIComponent(apiKey)}&torrent_id=${t.id}&file_id=${picked.id}&zip_link=false`,
        apiKey,
        signal,
      );
      if (typeof dl === 'string') return dl;
      return dl?.url ?? null;
    },

    async resolveDdl(link, signal) {
      // TorBox traite les liens d'hebergeur comme des « web downloads ».
      const created = await tbPost<{ webdownload_id?: number }>(
        '/webdl/createwebdownload',
        apiKey,
        { link },
        true,
        signal,
      );
      const id = created?.webdownload_id;
      if (id === undefined) return null;

      const dl = await tbGet<{ url?: string } | string>(
        `/webdl/requestdl?token=${encodeURIComponent(apiKey)}&web_id=${id}&file_id=0`,
        apiKey,
        signal,
      );
      if (typeof dl === 'string') return dl;
      return dl?.url ?? null;
    },

    async listFiles(magnetOrHash, signal) {
      const t = await addAndWait(magnetOrHash, apiKey, signal);
      return t ? toFiles(t) : [];
    },
  };
}
