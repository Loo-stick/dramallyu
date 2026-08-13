// Hebergeurs reellement supportes par les debrideurs de l'utilisateur.
//
// POURQUOI CE FICHIER EXISTE : j'avais ecrit la liste des hebergeurs « debridables »
// a la main dans le scraper Wawacity. Elle etait fausse, et de deux façons a la fois —
// elle retenait DailyUploads et Nitroflare, qu'AllDebrid ne prend pas, et elle ne
// disait rien de TorBox, qui prend justement Uploady, DailyUploads et Darkibox.
// Resultat : des flux affiches qui ne pouvaient pas se lire, et d'autres, jouables,
// jetes sans raison.
//
// Les deux services publient leur liste. On la leur demande.
//
//   AllDebrid : GET /v4/user/hosts        -> { hosts: { "1fichier": { status } } }
//   TorBox    : GET /v1/api/webdl/hosters -> [ { name, domains[], status } ]
//
// Le STATUT compte autant que la presence : un hebergeur connu mais marque inactif
// echouera au deblocage.

import axios from 'axios';
import { cached } from '../core/cache';
import type { UserConfig } from '../core/config';

const TTL_MS = 12 * 60 * 60 * 1000;

/** Normalise pour comparer : « 1Fichier », « 1fichier.com » -> « 1fichier ». */
export function normaliserHote(nom: string): string {
  return nom
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.(com|net|org|io|to|co|me|cc)$/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function hotesAllDebrid(apiKey: string): Promise<string[]> {
  return cached<string[]>(
    'hosts:alldebrid',
    TTL_MS,
    async () => {
      try {
        const res = await axios.get<{
          status?: string;
          data?: { hosts?: Record<string, { status?: boolean }> };
        }>('https://api.alldebrid.com/v4/user/hosts', {
          params: { agent: 'dramallyu', apikey: apiKey },
          timeout: 20000,
          validateStatus: () => true,
        });
        const hosts = res.data?.data?.hosts;
        if (!hosts) return [];
        return Object.entries(hosts)
          .filter(([, v]) => v?.status !== false)
          .map(([nom]) => normaliserHote(nom));
      } catch {
        return [];
      }
    },
    { scope: 'hosts', shouldCache: (v) => v.length > 0, negativeTtlMs: 30 * 60 * 1000 },
  );
}

async function hotesTorbox(apiKey: string): Promise<string[]> {
  return cached<string[]>(
    'hosts:torbox',
    TTL_MS,
    async () => {
      try {
        const res = await axios.get<{
          success?: boolean;
          data?: { name?: string; domains?: string[]; status?: boolean }[];
        }>('https://api.torbox.app/v1/api/webdl/hosters', {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 20000,
          validateStatus: () => true,
        });
        const liste = res.data?.data;
        if (!Array.isArray(liste)) return [];
        const out: string[] = [];
        for (const h of liste) {
          if (h?.status === false) continue;
          if (h?.name) out.push(normaliserHote(h.name));
          for (const d of h?.domains ?? []) out.push(normaliserHote(d));
        }
        return [...new Set(out)];
      } catch {
        return [];
      }
    },
    { scope: 'hosts', shouldCache: (v) => v.length > 0, negativeTtlMs: 30 * 60 * 1000 },
  );
}

/**
 * Hebergeurs que CET utilisateur peut debloquer, tous debrideurs confondus.
 *
 * L'union est le bon calcul : il suffit qu'un seul de ses services prenne
 * l'hebergeur pour que le fichier soit jouable, et le resolveur essaie les deux.
 */
export async function hotesSupportes(config: UserConfig): Promise<Set<string>> {
  const listes = await Promise.all([
    config.ad ? hotesAllDebrid(config.ad) : Promise.resolve([]),
    config.tb ? hotesTorbox(config.tb) : Promise.resolve([]),
  ]);
  return new Set(listes.flat());
}

/**
 * Cet hebergeur est-il exploitable ?
 *
 * Repond `true` quand on ne sait PAS (aucune liste disponible : pas de cle, ou les
 * deux API muettes). C'est la regle du projet — ne jamais couper sur une information
 * manquante — et elle evite qu'une panne d'API vide la liste de flux.
 */
export function hoteExploitable(hebergeur: string, supportes: Set<string>): boolean {
  if (supportes.size === 0) return true;
  const cible = normaliserHote(hebergeur);
  if (!cible) return true;
  for (const h of supportes) {
    if (h === cible || h.includes(cible) || cible.includes(h)) return true;
  }
  return false;
}
