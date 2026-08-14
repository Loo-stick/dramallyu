// Routage par MediaFlow Proxy.
//
// A QUOI ÇA SERT. Faire sortir les liens de lecture par UNE seule adresse IP. Un
// compte AllDebrid partage entre plusieurs personnes voit sinon ses liens consommes
// depuis autant d'adresses differentes, ce qu'AllDebrid sanctionne. Accessoirement,
// MediaFlow reinjecte les en-tetes HTTP sur CHAQUE segment d'un flux HLS, la ou
// Stremio n'applique `proxyHeaders` qu'a la requete initiale.
//
// LE MEDIAFLOW EST CELUI DE L'UTILISATEUR, PAS CELUI DE L'OPERATEUR.
//
// Ce n'est pas un detail d'organisation, c'est une contrainte : le mot de passe finit
// DANS L'URL DE LECTURE remise au lecteur (`api_password=`). Un MediaFlow d'operateur
// distribuerait donc son mot de passe a tous ses utilisateurs. Chacun apporte le sien,
// exactement comme pour les debrideurs et les trackers.
//
// ON NE ROUTE QUE CE QUI EST DEMANDE. Meme avec un MediaFlow declare, rien n'y passe
// tant que l'utilisateur n'a pas coche quoi : router un flux qui n'en a pas besoin
// ajoute une latence et une dependance pour rien.

import type { UserConfig } from './config';

export interface MediaflowConfig {
  url: string;
  password: string;
}

/**
 * Le MediaFlow declare par l'utilisateur, ou `null`.
 *
 * Les deux champs sont requis : une adresse sans mot de passe donnerait des URL que
 * MediaFlow refuse, donc des flux morts — mieux vaut ne pas router du tout.
 */
export function mediaflowConfig(config?: UserConfig): MediaflowConfig | null {
  const url = (config?.mfpUrl || '').trim().replace(/\/+$/, '');
  const password = (config?.mfpPass || '').trim();
  if (!url || !password) return null;
  return { url, password };
}

/** L'utilisateur a-t-il demande que ce type de lien passe par SON MediaFlow ? */
export function passeParMediaflow(config: UserConfig | undefined, quoi: 'ad' | 'tb' | 'direct'): boolean {
  if (!mediaflowConfig(config)) return false;
  return (config?.mfpPour ?? []).includes(quoi);
}

function isHls(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}

/**
 * Enveloppe une URL. Rend l'URL TELLE QUELLE si l'utilisateur n'a pas de MediaFlow ou
 * n'a pas demande ce routage : l'addon doit rester entierement fonctionnel sans lui.
 */
export function throughMediaflow(
  url: string,
  quoi: 'ad' | 'tb' | 'direct',
  config?: UserConfig,
  headers?: Record<string, string>,
): string {
  if (!passeParMediaflow(config, quoi)) return url;
  const cfg = mediaflowConfig(config);
  if (!cfg) return url;

  const endpoint = isHls(url) ? '/proxy/hls/manifest.m3u8' : '/proxy/stream';
  const params = new URLSearchParams({ d: url, api_password: cfg.password });
  // MediaFlow retransmet les en-tetes passes en h_* : indispensable pour les sources
  // qui exigent un Referer.
  for (const [k, v] of Object.entries(headers || {})) {
    params.set(`h_${k.toLowerCase()}`, v);
  }
  return `${cfg.url}${endpoint}?${params.toString()}`;
}
