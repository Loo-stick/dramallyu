// Routage par MediaFlow (mfp-light).
//
// POURQUOI, ET SEULEMENT POUR ALLDEBRID : un compte AllDebrid partage entre plusieurs
// personnes voit ses liens consommes depuis plusieurs adresses IP, ce qu'AllDebrid
// sanctionne. Faire sortir tous les liens par une seule IP — celle du serveur, via
// MediaFlow — supprime ce risque.
//
// TorBox n'a pas cette contrainte : ses liens partent en direct, sans intermediaire,
// donc sans consommer la bande passante du serveur.

export interface MediaflowConfig {
  url: string;
  password: string;
}

export function mediaflowConfig(): MediaflowConfig | null {
  const url = (process.env.MEDIAFLOW_URL || '').trim().replace(/\/+$/, '');
  const password = (process.env.MEDIAFLOW_PASSWORD || '').trim();
  if (!url || !password) return null;
  return { url, password };
}

function isHls(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url);
}

/**
 * Enveloppe une URL. Rend l'URL telle quelle si MediaFlow n'est pas configure :
 * l'addon doit rester fonctionnel sans lui, quitte a perdre cette protection.
 */
export function throughMediaflow(url: string, headers?: Record<string, string>): string {
  const cfg = mediaflowConfig();
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
