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
/**
 * Temps maximal accorde a ce classement.
 *
 * C'est une OPTIMISATION : elle decide par qui commencer, elle ne resout rien. Une
 * optimisation qui coute plus qu'elle ne rapporte doit etre abandonnee.
 *
 * Vecu le 2026-08-18 : TorBox s'est degrade — `checkcached` expirait a 25 s, `mylist` a
 * 20 s. Ce classement consommait donc a lui seul le budget entier de la resolution
 * (9 s), et la boucle qui suit s'arretait sur « budget epuise avant alldebrid » AVANT
 * d'avoir essaye AllDebrid, qui repondait pourtant en 290 ms. Resultat pour
 * l'utilisateur : 502 au clic sur Play, alors qu'un debrideur sain etait disponible.
 *
 * Passe ce delai on garde l'ordre par defaut : commencer peut-etre par le mauvais
 * service coute une seconde, ne rien servir coute la lecture.
 */
const BUDGET_TRI_MS = 1500;

/**
 * Temps maximal accorde a la verification de cache pendant l'enrichissement.
 *
 * Elle ne produit aucun flux : elle indique lesquels sont deja prets. Deux secondes
 * suffisent a un service sain sur un lot de quarante empreintes ; au-dela, le service
 * est en peine et l'attendre penalise CHAQUE recherche.
 */
const BUDGET_CACHE_MS = 2000;

async function ordonnerPourTorrent(
  services: DebridService[],
  hash: string,
  signal?: AbortSignal,
): Promise<DebridService[]> {
  if (services.length < 2) return services;

  // Le classement a sa PROPRE echeance, plus courte que celle de la resolution : un
  // service muet ne doit pas pouvoir manger le temps des autres.
  const borne = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(BUDGET_TRI_MS)])
    : AbortSignal.timeout(BUDGET_TRI_MS);

  const enCache: DebridService[] = [];
  const inconnu: DebridService[] = [];
  const absent: DebridService[] = [];

  for (const service of services) {
    if (!service.supportsCacheCheck) {
      inconnu.push(service);
      continue;
    }
    try {
      const carte = await service.checkCached([hash], borne);
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

  for (const [index, service] of services.entries()) {
    // On n'engage pas un service qu'on n'aura pas le temps d'ecouter : le suivant
    // repondrait apres l'abandon du lecteur, et son travail serait perdu.
    const restant = BUDGET_MS - (Date.now() - debut);
    if (restant <= 0) {
      console.log(`[Resolveur] budget epuise avant ${service.name}`);
      break;
    }

    // PART RESERVEE AU SUIVANT. Tant qu'il reste un service a essayer, celui-ci ne
    // recoit que six dixiemes du temps restant. Sans cette reserve, un debrideur muet
    // consomme tout et le suivant est saute au tour d'apres — c'est exactement ce qui
    // s'est produit quand TorBox s'est degrade : AllDebrid, sain et a 290 ms, n'etait
    // jamais essaye, et le lecteur recevait un 502.
    const part = index < services.length - 1 ? Math.round(restant * 0.6) : restant;
    const echeance = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(part)])
      : AbortSignal.timeout(part);

    try {
      const link =
        req.kind === 'torrent'
          ? await service.resolveTorrent(req.value, req.fileHint, echeance, req.torrentUrl)
          : await service.resolveDdl(req.value, echeance);
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
export interface Disponibilite {
  parHash: Map<string, NomDebrid[]>;
  /**
   * Vrai si AU MOINS UN debrideur a REPONDU.
   *
   * Sans cette distinction, un echec ou une expiration produisait une carte vide,
   * indiscernable d'un « verifie, rien n'est en cache ». Le filtre « uniquement ce qui
   * est pret » vidait alors la liste entiere : a froid, l'utilisateur ne voyait RIEN,
   * puis tout apparaissait au rechargement. Constate en production.
   */
  verifie: boolean;
}

export async function cacheParService(
  hashes: string[],
  config: UserConfig,
  signal?: AbortSignal,
): Promise<Disponibilite> {
  const parHash = new Map<string, NomDebrid[]>();
  const services = servicesFor(config).filter((s) => s.supportsCacheCheck);

  // EN PARALLELE. Les deux debrideurs etaient interroges l'un apres l'autre, ce qui
  // ajoutait leurs delais au lieu de les superposer — chacun repond en une a deux
  // secondes sur un lot de quarante hashes.
  //
  // L'ORDRE DU RESULTAT EST PRESERVE : `servicesFor` classe les services selon la
  // preference de l'utilisateur, et l'etiquette affichee nomme le PREMIER detenteur.
  // Collecter dans le desordre ferait mentir cette etiquette une fois sur deux.
  // ECHEANCE PROPRE A CHAQUE SERVICE. La verification de cache est un CONFORT : elle
  // pose une etiquette « pret » sur les flux, elle n'en produit aucun. Un debrideur muet
  // ne doit donc pas retenir la reponse.
  //
  // Vecu le 2026-08-18, TorBox degrade : son `checkcached` n'expirait plus qu'au bout de
  // 25 s, donc il consommait TOUT le budget d'enrichissement et chaque recherche mettait
  // 5,6 s au lieu de 2,5 — pour finir annulee sans rien rapporter. On paie desormais au
  // plus `BUDGET_CACHE_MS`, et les flux sortent sans etiquette plutot qu'en retard.
  const borne = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(BUDGET_CACHE_MS)])
    : AbortSignal.timeout(BUDGET_CACHE_MS);

  const reponses = await Promise.all(
    services.map((service) =>
      service
        .checkCached(hashes, borne)
        .then((m) => ({ m, ok: true }))
        .catch(() => ({ m: new Map<string, boolean>(), ok: false })),
    ),
  );

  services.forEach((service, i) => {
    for (const [hash, cached] of reponses[i].m) {
      if (!cached) continue;
      const liste = parHash.get(hash) ?? [];
      liste.push(service.name);
      parHash.set(hash, liste);
    }
  });

  return { parHash, verifie: reponses.some((r) => r.ok) };
}
