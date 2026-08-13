// Resolveur unifie : un candidat torrent ou DDL -> un lien HTTP jouable.
//
// C'est le coeur commun des piliers 2 et 3 annonce dans le design. Les sources ne
// savent rien du debridage ; elles rendent un hash ou un lien d'hebergeur, et tout se
// termine ici.

import type { DebridService } from './types';
import { extractHash } from './types';
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
/**
 * Ordonne les services pour un torrent donne, en interrogeant d'abord ceux qui savent
 * repondre sur le cache.
 *
 * MESURE QUI A MOTIVE CE CODE : avec les deux debrideurs configures, TorBox passait en
 * premier ; quand il n'avait pas le torrent, on l'attendait ~9 s avant de basculer sur
 * AllDebrid, qui repondait ensuite en 0,7 s. Soit 14,8 s au clic sur Play pour un
 * resultat obtenable en une seconde.
 *
 * L'ordre devient : ceux qui ONT le fichier en cache, puis ceux qui ne savent pas le
 * dire (AllDebrid), puis en dernier ceux qui ont repondu « non » — car pour eux il
 * faudrait attendre un telechargement.
 */
async function ordonnerPourTorrent(
  services: DebridService[],
  hash: string,
  signal?: AbortSignal,
): Promise<DebridService[]> {
  if (services.length < 2) return services;

  const enCache: DebridService[] = [];
  const inconnu: DebridService[] = [];
  const absent: DebridService[] = [];

  for (const service of services) {
    if (!service.supportsCacheCheck) {
      inconnu.push(service);
      continue;
    }
    try {
      const carte = await service.checkCached([hash], signal);
      (carte.get(hash.toLowerCase()) ? enCache : absent).push(service);
    } catch {
      // Un check-cache en echec ne disqualifie pas le service : on l'essaie quand meme.
      inconnu.push(service);
    }
  }
  return [...enCache, ...inconnu, ...absent];
}

export async function resolve(req: ResolveRequest, signal?: AbortSignal): Promise<string | null> {
  let services = servicesFor({ ad: req.ad, tb: req.tb } as UserConfig);
  if (services.length === 0) return null;

  if (req.kind === 'torrent') {
    const hash = extractHash(req.value);
    if (hash) services = await ordonnerPourTorrent(services, hash, signal);
  }

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
