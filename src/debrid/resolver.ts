// Resolveur unifie : un candidat torrent ou DDL -> un lien HTTP jouable.
//
// C'est le coeur commun des piliers 2 et 3 annonce dans le design. Les sources ne
// savent rien du debridage ; elles rendent un hash ou un lien d'hebergeur, et tout se
// termine ici.

import type { DebridService } from './types';
import { allDebrid } from './alldebrid';
import { torbox } from './torbox';
import { episodeHint } from './types';
import { throughMediaflow } from '../core/mediaflow';
import type { UserConfig } from '../core/config';

export { episodeHint };

/**
 * Services disponibles pour cet utilisateur, dans l'ordre ou on les essaie.
 *
 * TorBox d'abord quand les deux sont configures : il sait dire si un torrent est en
 * cache, donc il repond plus vite et plus souvent du premier coup.
 */
export function servicesFor(config: UserConfig): DebridService[] {
  const out: DebridService[] = [];
  if (config.tb) out.push(torbox(config.tb));
  if (config.ad) out.push(allDebrid(config.ad));
  return out;
}

export interface ResolveRequest {
  kind: 'torrent' | 'ddl';
  value: string;
  fileHint?: string;
  ad?: string;
  tb?: string;
}

/**
 * Resout et rend un lien jouable, ou null.
 *
 * Le routage final applique la regle du projet : ce qui vient d'AllDebrid repart par
 * MediaFlow (compte partage, protection multi-IP), ce qui vient de TorBox part en
 * direct.
 */
export async function resolve(req: ResolveRequest, signal?: AbortSignal): Promise<string | null> {
  const services = servicesFor({ ad: req.ad, tb: req.tb } as UserConfig);
  if (services.length === 0) return null;

  for (const service of services) {
    try {
      const link =
        req.kind === 'torrent'
          ? await service.resolveTorrent(req.value, req.fileHint, signal)
          : await service.resolveDdl(req.value, signal);
      if (!link) continue;
      return service.name === 'alldebrid' ? throughMediaflow(link) : link;
    } catch (e) {
      console.log(`[Resolveur] ${service.name}: ${(e as Error).message.slice(0, 100)}`);
    }
  }
  return null;
}

/**
 * Etat de cache d'un lot de hashes, pour l'affichage.
 *
 * Un hash absent de la carte signifie « on ne sait pas » — pas « non cache ». La
 * nuance compte : AllDebrid ne repond jamais, et afficher « non cache » a sa place
 * decouragerait a tort des flux parfaitement jouables.
 */
export async function cacheStatus(
  hashes: string[],
  config: UserConfig,
  signal?: AbortSignal,
): Promise<Map<string, boolean>> {
  const merged = new Map<string, boolean>();
  for (const service of servicesFor(config)) {
    if (!service.supportsCacheCheck) continue;
    try {
      for (const [hash, cached] of await service.checkCached(hashes, signal)) {
        if (cached || !merged.has(hash)) merged.set(hash, cached);
      }
    } catch {
      // Un check-cache en echec ne doit pas empecher d'afficher les flux.
    }
  }
  return merged;
}
