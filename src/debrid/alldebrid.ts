// AllDebrid (API v4). Porte depuis wastream et stream-fusion.
//
// TROIS PARTICULARITES A NE PAS OUBLIER :
//
//  1. LA DISPONIBILITE SE LIT DANS `/magnet/upload`. Il n'y a pas d'endpoint dedie,
//     et j'en avais conclu a tort qu'AllDebrid ne savait plus repondre. En realite on
//     depose un LOT (`magnets[]` repete) et chaque magnet revient avec un champ
//     `ready` — verifie contre `/magnet/status` : les deux concordent exactement.
//     C'est ainsi que procedent stream-fusion et wastream.
//     Piege associe : `ready` est le seul champ exploitable de cette reponse ;
//     `statusCode` n'existe que dans `/magnet/status`.
//  2. IL FAUT NETTOYER derriere soi. Chaque verification depose reellement les
//     magnets sur le compte, et ceux qui ne sont pas prets partent en telechargement.
//     Sans suppression, le compte se remplit en une journee et finit par buter sur la
//     limite de magnets actifs.
//  3. C'est AllDebrid qui debloque les liens d'hebergeur (1fichier, uptobox) via
//     /link/unlock — c'est ce qui fait vivre tout le pilier DDL.

import axios from 'axios';
import type { DebridFile, DebridService } from './types';
import { extractHash, pickFile, toMagnet } from './types';
import { get as cacheGet, set as cacheSet } from '../core/cache';
import { marquerMort } from './deadlinks';

const BASE = 'https://api.alldebrid.com/v4';
// `/magnet/status` a ete SUPPRIME de la v4 : elle repond desormais
// `{"status":"error","error":{"code":"DISCONTINUED"}}`. Constate en production le
// 2026-08-13 — c'est ce qui rendait tout le pilier torrent injouable. Le reste de la
// v4 fonctionne toujours ; seul cet appel bascule en v4.1.
const BASE_STATUS = 'https://api.alldebrid.com/v4.1';
const AGENT = 'dramallyu';
// Attente courte, et c'est deliberé. Un fichier deja present chez AllDebrid devient
// jouable en deux a quatre secondes ; au-dela, c'est qu'un vrai telechargement a
// demarre, et aucune attente raisonnable ne le verra finir. Patienter davantage ne
// changeait rien au resultat — sinon que l'utilisateur n'obtenait plus le message
// expliquant quoi faire, tout proxy raisonnable ayant coupe la connexion avant.
const POLL_ATTEMPTS = 3;
const POLL_DELAY_MS = 1200;

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
  base: string = BASE,
): Promise<T | null> {
  const qs = new URLSearchParams({ agent: AGENT, ...params }).toString();
  try {
    const res = await axios.get<AdResponse<T>>(`${base}${path}?${qs}`, {
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

export interface InfoLien {
  /** Taille reelle du fichier, quand l'hebergeur l'annonce. */
  taille?: number;
  /** Le fichier n'existe plus chez l'hebergeur. */
  mort: boolean;
  /** AllDebrid ne sait pas traiter cet hote — n'apprend RIEN sur le fichier. */
  hoteInconnu: boolean;
}

/**
 * Etat de plusieurs liens d'hebergeur, EN UNE SEULE REQUETE.
 *
 * `link/infos` accepte un lot de `link[]` et rend un verdict par lien. C'est ce qui
 * permet de savoir avant de proposer un flux si le fichier existe encore — mesure
 * faite sur un episode : 6 liens DDL sur 22 etaient deja morts, et l'addon les
 * proposait quand meme. Chaque clic dessus etait une erreur garantie.
 *
 * DEUX ERREURS A NE PAS CONFONDRE. `LINK_DOWN` dit que le fichier n'est plus la, et
 * c'est une information sure. `LINK_HOST_NOT_SUPPORTED` dit seulement qu'AllDebrid ne
 * gere pas cet hebergeur : le fichier peut etre parfaitement vivant, et TorBox peut
 * savoir l'ouvrir. Traiter le second comme le premier ferait disparaitre tout ce que
 * seul TorBox sert — la moitie du catalogue Wawacity.
 *
 * Les REDIRECTEURS ne se verifient pas ici : ils masquent l'hebergeur derriere une
 * page, donc `link/infos` rend forcement « hote inconnu ». Il faudrait les traverser
 * d'abord, une requete chacun — trop cher pendant une recherche.
 */
export async function infosLiens(
  urls: string[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<Map<string, InfoLien>> {
  const out = new Map<string, InfoLien>();
  const aVerifier = urls.filter((u) => !isRedirector(u));
  if (aVerifier.length === 0) return out;

  const corps = aVerifier.map((u) => `link[]=${encodeURIComponent(u)}`).join('&');
  try {
    const res = await axios.post<AdResponse<{ infos?: InfoBrute[] }>>(
      `${BASE}/link/infos?agent=${AGENT}&apikey=${encodeURIComponent(apiKey)}`,
      corps,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 12000,
        validateStatus: () => true,
        signal,
      },
    );
    if (res.status < 200 || res.status >= 300 || res.data?.status === 'error') return out;

    for (const info of res.data?.data?.infos ?? []) {
      if (!info.link) continue;
      const code = info.error?.code;
      out.set(info.link, {
        taille: typeof info.size === 'number' && info.size > 0 ? info.size : undefined,
        mort: code === 'LINK_DOWN',
        hoteInconnu: code === 'LINK_HOST_NOT_SUPPORTED',
      });
    }
  } catch {
    // Reseau indisponible ou lot refuse : on ne sait rien, donc on ne touche a rien.
    // Ne RIEN savoir doit laisser les flux passer, jamais les faire disparaitre.
  }
  return out;
}

interface InfoBrute {
  link?: string;
  size?: number;
  error?: { code?: string };
}

interface UploadedMagnet {
  id?: number;
  hash?: string;
  ready?: boolean;
  error?: { code?: string };
}

/**
 * Depose un fichier .torrent, plutot qu'un hash nu.
 *
 * C'EST LA SEULE FORME QUI MARCHE POUR UN TRACKER PRIVE. Un hash ne porte ni
 * annonceur ni metadonnees : le debrideur doit alors chercher des pairs dans le DHT,
 * ou les torrents prives ne figurent pas — par construction. Les depots restaient donc
 * inertes, visibles dans le tableau de bord et jamais demarres, meme avec seize sources
 * annoncees par le tracker.
 *
 * Le fichier est telecharge par NOS soins : le lien est signe par la cle de
 * l'utilisateur, AllDebrid ne peut pas le recuperer lui-meme.
 */
async function uploadFichierTorrent(
  torrentUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const res = await axios.get<ArrayBuffer>(torrentUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: 4 * 1024 * 1024,
      validateStatus: () => true,
      signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const contenu = Buffer.from(res.data);
    if (contenu.length === 0 || contenu[0] !== 0x64) return null; // doit commencer par 'd'

    const form = new FormData();
    form.append('files[]', new Blob([contenu]), 'release.torrent');

    const envoi = await axios.post<AdResponse<{ files?: UploadedMagnet[] }>>(
      `${BASE}/magnet/upload/file?agent=${AGENT}`,
      form,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30000, validateStatus: () => true, signal },
    );
    const premier = envoi.data?.data?.files?.[0];
    if (!premier || premier.error) {
      console.log(`[AllDebrid] depot du .torrent refuse: ${premier?.error?.code ?? envoi.status}`);
      return null;
    }
    return typeof premier.id === 'number' ? premier.id : null;
  } catch (e) {
    console.log(`[AllDebrid] depot du .torrent: ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
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

/**
 * Entree de l'arbre de fichiers renvoye par la v4.1.
 *
 * Les noms sont abreges chez AllDebrid : `n` le nom, `s` la taille, `l` le lien,
 * `e` les enfants. Et c'est un ARBRE, pas une liste — un torrent multi-fichiers
 * expose son dossier, dont les fichiers sont des enfants.
 */
interface AdEntry {
  n?: string;
  s?: number;
  l?: string;
  e?: AdEntry[];
}

interface MagnetStatus {
  status?: string;
  statusCode?: number;
  files?: AdEntry[];
}

/** Aplatit l'arbre. Un dossier n'a pas de `l` : seules les feuilles sont jouables. */
export function flattenEntries(entries: AdEntry[] | undefined, out: AdEntry[] = []): AdEntry[] {
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    out.push(entry);
    if (Array.isArray(entry.e)) flattenEntries(entry.e, out);
  }
  return out;
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
    BASE_STATUS,
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

/** Fichiers d'un magnet deja depose, designe par son identifiant. */
async function filesOfId(id: number, apiKey: string, signal?: AbortSignal): Promise<DebridFile[]> {
  const status = await waitReady(id, apiKey, signal);
  if (!status?.files) return [];

  // On ne garde que les entrees porteuses d'un lien : les dossiers de l'arbre n'en
  // ont pas, et les retenir ferait choisir un « fichier » injouable.
  return flattenEntries(status.files)
    .filter((e) => e.l && e.n)
    .map((e) => ({ name: e.n as string, sizeBytes: e.s, link: e.l }));
}

async function filesOf(
  magnetOrHash: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<DebridFile[]> {
  const id = await uploadMagnet(magnetOrHash, apiKey, signal);
  if (id === null) return [];
  return filesOfId(id, apiKey, signal);
}

const LOT_DISPO = 20;
// Un « pret » est stable : le fichier restera dans le cache partage d'AllDebrid.
// Un « pas pret » doit expirer vite — il suffit qu'une personne telecharge le fichier
// pour qu'il le devienne, et on ne veut pas afficher « a debrider » pendant des heures
// sur un flux devenu instantane.
const DISPO_TTL_MS = 6 * 60 * 60 * 1000;
const DISPO_ABSENT_TTL_MS = 20 * 60 * 1000;

/**
 * Depose un lot de magnets et rend, pour chacun, le champ `ready`.
 *
 * C'EST le controle de disponibilite d'AllDebrid. Il n'y a pas d'endpoint dedie —
 * j'avais conclu a tort qu'il n'en existait plus. La disponibilite se lit dans la
 * reponse de `/magnet/upload`, qui accepte plusieurs `magnets[]` d'un coup. Verifie
 * dans stream-fusion et wastream, qui procedent tous les deux ainsi.
 *
 * Piege documente par stream-fusion, reproduit ici : `ready` est le SEUL champ
 * exploitable de cette reponse. `statusCode` n'existe que dans `/magnet/status` — s'y
 * fier ici donnerait « non disponible » pour tout le monde.
 */
async function uploadLot(
  hashes: string[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<UploadedMagnet[]> {
  const corps = new URLSearchParams();
  for (const h of hashes) corps.append('magnets[]', h);

  try {
    const res = await axios.post<AdResponse<{ magnets?: UploadedMagnet[] }>>(
      `${BASE}/magnet/upload?agent=${AGENT}`,
      corps.toString(),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 20000,
        validateStatus: () => true,
        signal,
      },
    );
    const body = res.data;
    if (!body || body.status === 'error') {
      // Plafond de magnets actifs atteint : on ne marque RIEN comme indisponible,
      // ce serait une conclusion fausse tiree d'une limite de compte.
      console.log(`[AllDebrid] verification de dispo refusee: ${body?.error?.code ?? '?'}`);
      return [];
    }
    return body.data?.magnets ?? [];
  } catch (e) {
    console.log(`[AllDebrid] verification de dispo: ${(e as Error).message.slice(0, 80)}`);
    return [];
  }
}

/**
 * Magnets DEJA presents dans le compte, avant que la verification n'y touche.
 *
 * Un seul appel rend toute la liste. Il est indispensable : la verification depose des
 * dizaines de hashes puis les retire, et sans cette photographie prealable elle
 * supprimait aussi ce qui etait la AVANT — le telechargement que l'utilisateur venait
 * de lancer en cliquant Play, ou un magnet qu'il avait ajoute lui-meme.
 *
 * Symptome cote utilisateur, constate : des entrees apparaissent dans le tableau de
 * bord AllDebrid et n'avancent jamais, meme avec seize sources. Elles etaient
 * supprimees a la recherche suivante.
 */
async function magnetsExistants(
  apiKey: string,
  signal?: AbortSignal,
): Promise<Map<string, boolean>> {
  // On memorise un OBJET NU, pas une Map : le cache serialise en JSON, et une Map y
  // reviendrait vide. Le defaut a deja ete vecu sur la verification des liens DDL.
  const memo = cacheGet<Record<string, boolean>>('ad:compte');
  if (memo && typeof memo === 'object') return new Map(Object.entries(memo));

  const data = await call<{ magnets?: { hash?: string; status?: string }[] }>(
    '/magnet/status',
    apiKey,
    {},
    signal,
    BASE_STATUS,
  );
  const brut: Record<string, boolean> = {};
  for (const m of data?.magnets ?? []) {
    if (m.hash) brut[m.hash.toLowerCase()] = /ready/i.test(m.status ?? '');
  }
  if (Object.keys(brut).length > 0) cacheSet('ad:compte', brut, ETAT_COMPTE_TTL_MS, 'alldebrid');
  return new Map(Object.entries(brut));
}

/**
 * Duree pendant laquelle l'etat du compte fait foi.
 *
 * Courte, et c'est le point : ce qu'on a dans SON PROPRE compte prime sur toute
 * memorisation. Un fichier telecharge a la demande de l'utilisateur devenait pret en
 * quelques minutes, mais restait affiche « a debrider » pendant vingt — la duree du
 * cache de disponibilite. Il voyait son telechargement termine chez AllDebrid et
 * l'addon continuait de lui promettre une attente.
 */
const ETAT_COMPTE_TTL_MS = 60 * 1000;

/**
 * Retire les magnets deposes pour le seul besoin de la verification.
 *
 * J'avais d'abord garde ceux qui etaient prets, en pensant menager une eventuelle
 * bibliotheque de l'utilisateur. C'etait une erreur, mesuree : chaque requete /stream
 * depose jusqu'a quarante hashes, et n'en retirer qu'une partie fait gonfler le compte
 * sans fin — 194 magnets accumules en une seule journee de tests. AllDebrid plafonne
 * en plus le nombre de magnets actifs, donc la verification finit par echouer.
 *
 * Supprimer un magnet PRET ne coute rien : il reste dans le cache partage d'AllDebrid,
 * et le redeposer plus tard est instantane. C'est aussi ce que fait stream-fusion.
 */
/**
 * Empreintes que NOUS avons deposees pour verifier, et pas encore retirees.
 *
 * La garde `!dejaLa.has(hash)` protege les magnets de l'utilisateur — mais elle se
 * retourne : des qu'un de nos depots survit a un passage (suppression ratee, ou
 * photographie prise pendant que la suppression precedente courait encore), il figure
 * dans TOUTES les photographies suivantes, donc il passe pour un magnet de
 * l'utilisateur et n'est PLUS JAMAIS supprime. La fuite s'entretient toute seule.
 *
 * Constate le 2026-08-20 : 377 magnets dans le compte, dont cinq portant un simple
 * hash pour nom — signature de la verification — bloques sur « No peer after 30
 * minutes », et un « Head Over Heels » en cours de telechargement alors que
 * l'utilisatrice n'avait rien lance : toutes ses lectures partaient chez TorBox.
 *
 * On retient donc CE QUI EST A NOUS. Une empreinte sort de l'ensemble des qu'elle est
 * effectivement supprimee : si l'utilisateur la redepose ensuite en lisant un flux,
 * elle redevient protegee par la photographie, comme il se doit.
 */
const deposesParVerification = new Set<string>();

function nettoyerEnFond(ids: { id: number; hash: string }[], apiKey: string): void {
  if (ids.length === 0) return;
  void (async () => {
    let retires = 0;
    let echoues = 0;
    for (const { id, hash } of ids) {
      const ok = await call('/magnet/delete', apiKey, { id: String(id) }).catch(() => null);
      if (ok) {
        retires++;
        // Retiree de nos depots SEULEMENT une fois partie : tant qu'elle est la, elle
        // reste a nous, et le passage suivant retentera.
        deposesParVerification.delete(hash);
      } else {
        echoues++;
      }
    }
    // ON DIT CE QUI RESTE. L'echec etait avale par un `.catch` muet : le compte de
    // l'utilisateur pouvait se remplir de nos depots de verification sans qu'une seule
    // ligne le signale, et l'on ne pouvait meme pas repondre a « est-ce que vous les
    // supprimez vraiment ? » autrement que par la lecture du code.
    console.log(
      `[AllDebrid] verification : ${retires}/${ids.length} magnet(s) retire(s)` +
        (echoues > 0 ? ` — ${echoues} NON RETIRE(S), ils restent dans le compte` : ''),
    );
  })();
}

export function allDebrid(apiKey: string): DebridService {
  return {
    name: 'alldebrid',
    supportsCacheCheck: true,
    // Repondre lui coute un depot, et un telechargement quand il n'a pas le fichier.
    verificationDepose: true,

    async checkCached(hashes, signal) {
      const out = new Map<string, boolean>();
      const aInterroger: string[] = [];

      // On MEMORISE le verdict par hash. Sans ca, chaque ouverture d'un episode
      // redeposerait quarante magnets chez AllDebrid : c'est lent, ca frotte contre
      // leur limite de magnets actifs, et le resultat ne change pas d'une minute a
      // l'autre. Un « pret » se garde plus longtemps qu'un « pas pret », qui peut
      // devenir vrai des que quelqu'un aura telecharge le fichier.
      // L'etat du COMPTE fait foi, avant toute memorisation : ce qu'on y trouve pret
      // l'est vraiment, maintenant. Sans cette priorite, un fichier telechargé a la
      // demande de l'utilisateur restait annonce « a debrider » pendant vingt minutes
      // — la duree du cache — alors qu'il le voyait termine chez AllDebrid.
      const compte = await magnetsExistants(apiKey, signal);

      for (const brut of new Set(hashes.map((h) => h.toLowerCase()))) {
        if (!/^[a-f0-9]{40}$/.test(brut)) continue;
        const dansCompte = compte.get(brut);
        if (dansCompte === true) {
          out.set(brut, true);
          cacheSet(`ad:dispo:${brut}`, true, DISPO_TTL_MS, 'alldebrid');
          continue;
        }
        const memorise = cacheGet<boolean>(`ad:dispo:${brut}`);
        if (memorise === null) aInterroger.push(brut);
        else out.set(brut, memorise);
      }

      // La photographie du compte dit aussi ce qui ne nous appartient PAS : on ne
      // retirera que nos propres depots.
      const dejaLa = compte;

      for (let i = 0; i < aInterroger.length; i += LOT_DISPO) {
        if (signal?.aborted) break;
        const lot = aInterroger.slice(i, i + LOT_DISPO);
        const magnets = await uploadLot(lot, apiKey, signal);
        if (magnets.length === 0) continue;

        const aRetirer: { id: number; hash: string }[] = [];
        for (const m of magnets) {
          const hash = (m.hash || '').toLowerCase();
          if (!hash) continue;
          const pret = Boolean(m.ready);
          out.set(hash, pret);
          cacheSet(`ad:dispo:${hash}`, pret, pret ? DISPO_TTL_MS : DISPO_ABSENT_TTL_MS, 'alldebrid');
          // On ne retire QUE ce qu'on vient d'ajouter. Ce qui etait deja la appartient
          // a l'utilisateur — telechargement lance depuis l'addon, ou magnet ajoute a
          // la main — et n'a pas a disparaitre parce qu'on a regarde s'il etait pret.
          // A NOUS dans deux cas : l'empreinte n'etait pas dans le compte avant ce
          // lot, ou bien nous l'avons deja deposee sans reussir a la retirer — et dans
          // ce second cas la photographie la montre, ce qui la faisait passer pour un
          // magnet de l'utilisateur A TOUT JAMAIS.
          //
          // La photographie reste la protection de reference : un fichier que
          // l'utilisateur a lance en lisant un flux, ou ajoute a la main, n'est pas dans
          // notre ensemble et ne sera pas touche. C'est un defaut deja vecu — des
          // telechargements disparaissaient a la recherche suivante — et il ne doit pas
          // revenir par la correction d'un autre.
          const aNous = !dejaLa.has(hash) || deposesParVerification.has(hash);
          if (aNous && typeof m.id === 'number') {
            deposesParVerification.add(hash);
            aRetirer.push({ id: m.id, hash });
          }
        }
        nettoyerEnFond(aRetirer, apiKey);
      }
      return out;
    },

    async resolveTorrent(magnetOrHash, fileHint, signal, torrentUrl) {
      let files = await filesOf(magnetOrHash, apiKey, signal);

      // Rien du cote du hash : sur un tracker prive, c'est normal — le depot d'un hash
      // nu n'aboutit jamais, faute d'annonceur. On depose alors le VRAI fichier.
      if (files.length === 0 && torrentUrl) {
        const id = await uploadFichierTorrent(torrentUrl, apiKey, signal);
        if (id !== null) files = await filesOfId(id, apiKey, signal);
      }
      const picked = pickFile(files, fileHint);
      if (!picked?.link) return null;
      // Les liens de /magnet/status sont des liens AllDebrid, pas encore des liens
      // de telechargement : il faut les passer par /link/unlock.
      return this.resolveDdl(picked.link, signal);
    },

    async resolveDdl(link, signal) {
      return resoudreDdl(link, apiKey, signal);
    },

    async listFiles(magnetOrHash, signal) {
      return filesOf(magnetOrHash, apiKey, signal);
    },
  };
}

export { extractHash };

/**
 * Erreurs TRANSITOIRES d'AllDebrid : elles meritent une nouvelle tentative.
 *
 * Liste reprise de wastream, ou elle est le fruit de l'usage. `REDIRECTOR_ERROR` en
 * fait partie, et c'est ce qui m'avait echappe : j'abandonnais au premier echec et
 * j'en avais conclu que dl-protect etait infranchissable. Il ne l'est que par
 * intermittence — la meme requete rejouee aboutit.
 *
 * `LINK_DOWN` n'y figure pas, volontairement : le fichier n'est plus chez
 * l'hebergeur, rejouer ne le ressuscitera pas.
 */
const ERREURS_A_REESSAYER = new Set([
  'REDIRECTOR_ERROR',
  'LINK_HOST_UNAVAILABLE',
  'LINK_TEMPORARY_UNAVAILABLE',
  'LINK_TOO_MANY_DOWNLOADS',
  'LINK_HOST_FULL',
  'LINK_HOST_LIMIT_REACHED',
]);

const DDL_TENTATIVES = 4;
const DDL_ATTENTE_MS = 3000;

/** Comme `call`, mais rend AUSSI le code d'erreur — indispensable pour decider d'un retry. */
async function callDetaille<T>(
  path: string,
  apiKey: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ data: T | null; code?: string }> {
  const qs = new URLSearchParams({ agent: AGENT, ...params }).toString();
  try {
    const res = await axios.get<AdResponse<T>>(`${BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 25000,
      validateStatus: () => true,
      signal,
    });
    const body = res.data;
    if (!body || body.status === 'error') {
      const code = body?.error?.code;
      if (code) console.log(`[AllDebrid] ${path}: ${code}`);
      return { data: null, code };
    }
    return { data: (body.data ?? null) as T | null };
  } catch (e) {
    console.log(`[AllDebrid] ${path}: ${(e as Error).message.slice(0, 80)}`);
    return { data: null };
  }
}

async function resoudreDdl(
  link: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
  for (let essai = 0; essai < DDL_TENTATIVES; essai++) {
    if (signal?.aborted) return null;

    // Les sites DDL francais ne publient jamais le lien d'hebergeur en clair : il est
    // derriere un REDIRECTEUR (dl-protect, zoneurs). /link/unlock echoue dessus —
    // AllDebrid a un endpoint dedie, qu'il faut appeler d'abord.
    let cible = link;
    if (isRedirector(link)) {
      const redir = await callDetaille<{ links?: string[] }>('/link/redirector', apiKey, { link }, signal);
      const premier = redir.data?.links?.find((l) => typeof l === 'string' && /^https?:\/\//.test(l));
      if (!premier) {
        if (redir.code && ERREURS_A_REESSAYER.has(redir.code) && essai < DDL_TENTATIVES - 1) {
          await sleep(DDL_ATTENTE_MS);
          continue;
        }
        return null;
      }
      cible = premier;
    }

    const deblocage = await callDetaille<{ link?: string }>('/link/unlock', apiKey, { link: cible }, signal);
    if (deblocage.data?.link) return deblocage.data.link;

    // Le fichier n'existe plus chez l'hebergeur. On le retient : le site DDL, lui, le
    // publiera encore pendant des semaines, et rien ne sert de le reproposer.
    // On memorise le lien D'ORIGINE — celui que la source rendra a nouveau.
    if (deblocage.code === 'LINK_DOWN') marquerMort(link);

    if (deblocage.code && ERREURS_A_REESSAYER.has(deblocage.code) && essai < DDL_TENTATIVES - 1) {
      await sleep(DDL_ATTENTE_MS);
      continue;
    }
    return null;
  }
  return null;
}
