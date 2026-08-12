// Construction des URLs absolues que l'addon met dans ses reponses (/resolve, /sub).
//
// Elles doivent etre joignables DEPUIS LE CLIENT (une TV, un telephone sur un autre
// reseau), pas depuis le serveur. Derriere Apache + Cloudflare, seule la lecture des
// en-tetes X-Forwarded-* donne le bon schema et le bon hote — d'ou `trust proxy`.

import type { Request } from 'express';

export function getBaseUrl(req: Request): string {
  const configured = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;

  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || req.protocol || 'http';
  const host =
    (req.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim() ||
    req.get('host') ||
    `localhost:${process.env.PORT || 7020}`;
  return `${proto}://${host}`;
}

/** Segment de config a reinjecter dans les URLs auto-referentes, s'il y en a un. */
export function configSegment(req: Request): string {
  const cfg = (req.params as Record<string, string>).config;
  return cfg ? `/${cfg}` : '';
}
