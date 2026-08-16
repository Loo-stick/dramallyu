// Resolveur unifie : un candidat torrent ou DDL -> un lien HTTP jouable.
//
// C'est le coeur commun des piliers 2 et 3 annonce dans le design. Les sources ne
// savent rien du debridage ; elles rendent un hash ou un lien d'hebergeur, et tout se
// termine ici.

import type { DebridService } from './types';
import { extractHash } from './types';
import { allDebrid, isRedirector } from './alldebrid';
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
  // Preference de l'utilisateur. Elle ne joue qu'a defaut de cache : `ordonnerPourTorrent`
  // repasse devant pour placer en tete ce qui est deja pret, et une preference ne vaut
  // pas de renoncer a une lecture immediate.
  if (config.debrid === 'alldebrid') {
    out.sort((a, b) => (a.name === 'alldebrid' ? -1 : b.name === 'alldebrid' ? 1 : 0));
  } else if (config.debrid === 'torbox') {
    out.sort((a, b) => (a.name === 'torbox' ? -1 : b.name === 'torbox' ? 1 : 0));
  }
  return out;
}

export interface ResolveRequest {
  kind: 'torrent' | 'ddl';
  value: string;
  fileHint?: string;
  /** Lien .torrent, employe au Play quand le hash seul n'aboutit pas. */
  torrentUrl?: string;
  ad?: string;
  tb?: string;
  /** MediaFlow de l'utilisateur, tel qu'il voyage dans le jeton de lecture. */
  mfpUrl?: string;
  mfpPass?: string;
  mfpPour?: ('ad' | 'tb' | 'direct')[];
  /** Preference de l'utilisateur, transportee dans le jeton de lecture. */
  pref?: 'auto' | 'alldebrid' | 'torbox';
}

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

/**
 * Resout et rend un lien jouable, ou null.
 *
 * Le routage final applique la regle du projet : ce qui vient d'AllDebrid repart par
 * MediaFlow (compte partage, protection multi-IP), ce qui vient de TorBox part en
 * direct.
 */
/**
 * Temps maximal accorde a une resolution, tous services confondus.
 *
 * Un clic sur Play doit aboutir ou echouer VITE. Sans cette borne, essayer deux
 * debrideurs a la suite sur un fichier absent prenait 22 s : le lecteur avait
 * abandonne, et le proxy renvoyait une page d'erreur a la place du message qui
 * explique quoi faire. Mieux vaut dire « pas pret, reessayez » en huit secondes que
 * ne rien dire du tout en vingt-deux.
 */
const BUDGET_MS = 9000;

/**
 * Ce qu'une resolution a produit, et par quel chemin.
 *
 * Le lien seul ne suffisait pas : `/resolve` redirigeait sans rien journaliser, si
 * bien qu'une lecture reussie ne laissait AUCUNE trace. Impossible de repondre a
 * « est-ce bien passe par mon MediaFlow ? » autrement qu'en croyant l'utilisateur sur
 * parole. On rend donc aussi le service qui a repondu et le fait d'avoir enveloppe.
 */
export interface Resolution {
  lien: string;
  service: 'alldebrid' | 'torbox';
  parMediaflow: boolean;
}

export async function resolve(req: ResolveRequest, signal?: AbortSignal): Promise<Resolution | null> {
  const debut = Date.now();
  let services = servicesFor({ ad: req.ad, tb: req.tb, debrid: req.pref ?? 'auto' } as UserConfig);
  if (services.length === 0) return null;

  if (req.kind === 'torrent') {
    const hash = extractHash(req.value);
    if (hash) services = await ordonnerPourTorrent(services, hash, signal);
  } else if (isRedirector(req.value)) {
    // Un lien DDL francais est presque toujours derriere un redirecteur (dl-protect,
    // zoneurs). Seul AllDebrid sait les traverser, via /link/redirector : le placer
    // en tete evite d'essayer TorBox pour rien, qui echouerait sur la page
    // intermediaire.
    services = [...services].sort((a, b) => (a.name === 'alldebrid' ? -1 : b.name === 'alldebrid' ? 1 : 0));
  }

  for (const service of services) {
    // On n'engage pas un service qu'on n'aura pas le temps d'ecouter : le suivant
    // repondrait apres l'abandon du lecteur, et son travail serait perdu.
    if (Date.now() - debut > BUDGET_MS) {
      console.log(`[Resolveur] budget epuise avant ${service.name}`);
      break;
    }
    try {
      const link =
        req.kind === 'torrent'
          ? await service.resolveTorrent(req.value, req.fileHint, signal, req.torrentUrl)
          : await service.resolveDdl(req.value, signal);
      if (!link) continue;
      // Chaque debrideur a son propre interrupteur : le compte partage n'est pas
      // toujours le meme, et router TorBox quand seul AllDebrid pose probleme ferait
      // transiter de la video pour rien.
      const mfp = { mfpUrl: req.mfpUrl, mfpPass: req.mfpPass, mfpPour: req.mfpPour } as UserConfig;
      const enveloppe = throughMediaflow(link, service.name === 'alldebrid' ? 'ad' : 'tb', mfp);
      return { lien: enveloppe, service: service.name, parMediaflow: enveloppe !== link };
    } catch (e) {
      console.log(`[Resolveur] ${service.name}: ${(e as Error).message.slice(0, 100)}`);
    }
  }
  return null;
}

export type NomDebrid = 'alldebrid' | 'torbox';

/**
 * Qui, parmi les debrideurs de l'utilisateur, a deja ce fichier.
 *
 * On garde le detail PAR SERVICE plutot qu'un simple oui/non : c'est ce qui permet
 * d'annoncer le bon debrideur sur chaque flux au lieu de le deviner. Et l'ordre
 * suivi ici est celui de `servicesFor`, donc le meme que celui de la resolution —
 * l'etiquette affichee correspond bien au service qui servira le fichier.
 */
export async function cacheParService(
  hashes: string[],
  config: UserConfig,
  signal?: AbortSignal,
): Promise<Map<string, NomDebrid[]>> {
  const parHash = new Map<string, NomDebrid[]>();
  const services = servicesFor(config).filter((s) => s.supportsCacheCheck);

  // EN PARALLELE. Les deux debrideurs etaient interroges l'un apres l'autre, ce qui
  // ajoutait leurs delais au lieu de les superposer — chacun repond en une a deux
  // secondes sur un lot de quarante hashes.
  //
  // L'ORDRE DU RESULTAT EST PRESERVE : `servicesFor` classe les services selon la
  // preference de l'utilisateur, et l'etiquette affichee nomme le PREMIER detenteur.
  // Collecter dans le desordre ferait mentir cette etiquette une fois sur deux.
  const reponses = await Promise.all(
    services.map((service) =>
      service.checkCached(hashes, signal).catch(() => new Map<string, boolean>()),
    ),
  );

  services.forEach((service, i) => {
    for (const [hash, cached] of reponses[i]) {
      if (!cached) continue;
      const liste = parHash.get(hash) ?? [];
      liste.push(service.name);
      parHash.set(hash, liste);
    }
  });

  return parHash;
}
