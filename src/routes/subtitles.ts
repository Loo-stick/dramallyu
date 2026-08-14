// Ressource /subtitles + endpoint de service des pistes.
//
// POURQUOI UNE RESSOURCE ET PAS DES SUBS SUR LE STREAM : Nuvio IGNORE purement et
// simplement le champ `subtitles` d'un objet Stream (verifie sur HLS comme sur MP4).
// La ressource est le seul mecanisme qui marche sur les deux clients. Corollaire :
// on ne met JAMAIS aussi les sous-titres au niveau du stream, sinon Nuvio empile les
// pistes en double.
//
// Deux autres regles imposees par les clients :
//   - codes langue en ISO 639-2 (fre/eng), pas en ISO 639-1 (fr/en) ;
//   - les URLs pointent vers NOS endpoints, qui servent du text/vtt — un lien direct
//     vers l'hebergeur d'origine ne s'affiche pas (CORS, format, en-tetes).

import type { Request, Response } from 'express';
import { parseConfig, nomLangue } from '../core/config';
import { parseStremioId } from '../core/ids';
import { resolveWork, estAsiatique } from '../core/meta';
import { subtitlesAll } from '../core/registry';
import { findSubtitles } from '../subs/opensubtitles';
import { toVtt } from '../subs/convert';
import { estChiffre, dechiffrerVtt } from '../sources/direct/kisskh/subdecrypt';
import { getBaseUrl } from '../core/url';
import { encodeToken, decodeToken } from '../debrid/token';
import { httpGet } from '../core/http';
import { get, set } from '../core/cache';
import { createHash } from 'node:crypto';
import type { MediaType, SubTrack } from '../sources/types';

/**
 * Adresse STABLE d'une piste, derivee de son contenu.
 *
 * Elle etait chiffree, donc differente a chaque appel : le vecteur d'initialisation
 * est aleatoire, par construction. Consequence, invisible jusqu'a ce qu'on la cherche
 * — aucun cache intermediaire ne pouvait servir deux fois la meme piste, puisqu'il ne
 * voyait jamais deux fois la meme URL. Cloudflare comptait chaque requete comme
 * nouvelle et la faisait remonter jusqu'ici.
 *
 * On adresse donc par le CONTENU : l'identifiant est une empreinte de l'URL source,
 * et la correspondance est gardee de notre cote. C'est aussi plus sur que le jeton
 * chiffre — l'endpoint ne peut servir QUE des adresses qu'on a nous-memes enregistrees,
 * la ou un jeton dechiffrable acceptait tout ce qui se dechiffrait correctement.
 */
const TTL_ADRESSE_MS = 30 * 24 * 60 * 60 * 1000;

export function adresseDePiste(base: string, url: string): string {
  const id = createHash('sha256').update(url).digest('base64url').slice(0, 32);
  set(`subid:${id}`, url, TTL_ADRESSE_MS, 'subid');
  return `${base}/sub/${id}.vtt`;
}

function subUrl(base: string, track: SubTrack): string {
  return adresseDePiste(base, track.url);
}

export async function handleSubtitles(req: Request, res: Response): Promise<void> {
  const config = parseConfig((req.params as Record<string, string>).config);
  const type: MediaType = req.params.type === 'movie' ? 'movie' : 'series';
  const parsed = parseStremioId(req.params.id);
  if (!parsed) {
    res.json({ subtitles: [] });
    return;
  }

  try {
    const work = await resolveWork(parsed, type, config);
    if (!work) {
      res.json({ subtitles: [] });
      return;
    }

    // Hors creneau : on s'arrete AVANT d'interroger la moindre source. Repondre une
    // liste vide apres avoir scrape et depose des magnets ne servirait personne.
    if (!estAsiatique(work)) {
      console.log(`[Perimetre] ${req.params.id} hors creneau (${work.country ?? work.originalLanguage ?? '?'})`);
      res.json({ subtitles: [] });
      return;
    }

    const query = {
      type,
      imdbId: work.imdbId,
      tmdbId: work.tmdbId,
      kkhId: work.kkhId,
      titles: work.titles,
      year: work.year,
      season: parsed.season,
      episode: parsed.episode,
      originalLanguage: work.originalLanguage,
    };

    // Les sources d'abord (KissKH porte de vraies pistes synchronisees avec SON flux),
    // OpenSubtitles ensuite en complement pour les langues manquantes.
    const fromSources = await subtitlesAll(query, config);
    const missing = config.subLangs.filter((l) => !fromSources.some((t) => t.lang === l));
    const external = (
      await Promise.all(
        missing.map((lang) =>
          findSubtitles(work.imdbId, lang, parsed.season, parsed.episode).catch(() => []),
        ),
      )
    ).flat();

    const base = getBaseUrl(req);
    const seen = new Set<string>();
    const rang = (lang: string): number => {
      const i = config.subLangs.indexOf(lang);
      return i === -1 ? 100 : i;
    };

    const uniques = [...fromSources, ...external].filter((t) => {
      if (seen.has(t.url)) return false;
      seen.add(t.url);
      return true;
    });

    // ON NE SERT QUE LES LANGUES DEMANDEES.
    //
    // KissKH livre parfois sept pistes — khmer, indonesien, malais, thai, arabe —
    // pour quelqu'un qui n'a demande que le francais. Les renvoyer toutes a deux
    // couts : elles encombrent le menu du lecteur, et surtout certains lecteurs les
    // PRECHARGENT. Sur le trajet reel (Cloudflare puis liaison domestique), chaque
    // piste coute ~200 ms : sept pistes au lieu d'une, c'est une seconde et demie
    // d'attente pour rien. C'est exactement l'ecart de ressenti avec LooStream, qui
    // n'interroge OpenSubtitles qu'en francais.
    //
    // REPLI INDISPENSABLE : si aucune piste ne correspond, on rend ce qu'on a. Un
    // sous-titre dans une langue approchante vaut mieux qu'un menu vide, et
    // l'utilisateur reste libre de l'ignorer.
    const demandees = uniques.filter((t) => config.subLangs.includes(t.lang));
    const retenues = demandees.length > 0 ? demandees : uniques;

    const subtitles = retenues
      // TRI FINAL, et il est indispensable : concatener « sources puis OpenSubtitles »
      // renvoie le francais en DERNIER des que la source n'en a pas — alors que c'est
      // justement la langue que l'utilisateur a demandee en premier. Les lecteurs
      // presentent les pistes dans l'ordre reçu.
      .sort((a, b) => rang(a.lang) - rang(b.lang))
      .map((t, i) => ({
        // Identifiant prefixe par un CHIFFRE, et c'est deliberé.
        //
        // Certains lecteurs presentent les pistes dans l'ordre reçu, d'autres les
        // trient sur l'id. Dans le second cas, `dramallyu-…` partait derriere a peu
        // pres tout l'alphabet — un chiffre trie avant les lettres en ASCII, donc nos
        // pistes remontent. C'est une hypothese, pas une certitude : Nuvio n'est pas
        // ouvert et rien ne dit qu'il trie sur ce champ. Le pari est sans risque, un
        // lecteur qui conserve l'ordre reçu ne verra aucune difference. L'id reste
        // unique et stable, c'est tout ce que le protocole en demande.
        id: `0${i}-dramallyu`,
        url: subUrl(base, t),
        lang: t.lang,
        // Meme raison que pour les pistes attachees : Nuvio lit un NOM de langue.
        language: nomLangue(t.lang),
        // AUCUN DRAPEAU « default » ICI, et c'est un retour en arriere assume.
        //
        // Cette ressource repond pour N'IMPORTE QUEL flux, y compris ceux d'un autre
        // addon et les releases torrent qui embarquent leurs propres pistes. Sur une
        // release « Multi-Subs », les sous-titres INTEGRES sont cales au frame pres,
        // alors que les notres viennent d'un autre encodage — montage different,
        // recaps, coupures : tout glisse.
        //
        // Marquer notre piste par defaut detournait donc la selection automatique du
        // lecteur au profit de la moins bonne. Le drapeau avait ete pose pour corriger
        // l'ordre d'affichage dans Nuvio ; il ne l'a jamais corrige (c'est la position
        // de l'addon dans la liste qui commande), et il coutait ça.
      }));

    // Preparation en tache de fond, AVANT de repondre : le lecteur passera quelques
    // dizaines de millisecondes a lire notre JSON, autant s'en servir.
    prechauffer(retenues.map((t) => t.url));

    res.json({ subtitles });
  } catch (e) {
    console.error(`[Subtitles] echec ${req.params.id}: ${(e as Error).message}`);
    res.json({ subtitles: [] });
  }
}

const MAX_SUB_BYTES = 4 * 1024 * 1024;

/**
 * Recupere une piste, la convertit en VTT, la dechiffre au besoin, et la memorise.
 *
 * Extrait du gestionnaire HTTP pour pouvoir etre appele AILLEURS : c'est ce qui permet
 * de preparer une piste avant que le lecteur ne la demande.
 */
async function preparerVtt(url: string): Promise<string | null> {
  const cleVtt = `vtt:${url}`;
  const memorise = get<string>(cleVtt);
  if (memorise) return memorise;

  // En binaire : OpenSubtitles sert des .srt.gz, qu'un decodage texte detruirait
  // avant meme qu'on puisse les decompresser.
  const response = await httpGet<ArrayBuffer>(url, {
    timeoutMs: 15000,
    responseType: 'buffer',
    maxBytes: MAX_SUB_BYTES,
    retries: 1,
  });
  if (!response || response.status < 200 || response.status >= 300) return null;

  const buf = Buffer.isBuffer(response.data)
    ? (response.data as Buffer)
    : Buffer.from(response.data as ArrayBuffer);
  const vtt = toVtt(buf);
  if (!vtt) return null;

  // Pistes KissKH chiffrees : le FICHIER est structurellement valide, seules les
  // repliques sont brouillees. On tente le dechiffrement, et on refuse de servir si
  // le resultat n'est pas credible — du charabia par-dessus la video serait pire que
  // pas de sous-titres du tout.
  let corps = vtt;
  if (estChiffre(url)) {
    const clair = await dechiffrerVtt(vtt, url);
    if (!clair) return null;
    corps = clair;
  }

  // Une piste ne change jamais : douze heures de memorisation, et la selection
  // suivante est instantanee. On borne la taille memorisee — un fichier aberrant n'a
  // pas a occuper le cache partage par tout le reste.
  if (corps.length < 512 * 1024) set(cleVtt, corps, 12 * 60 * 60 * 1000, 'vtt');
  return corps;
}

/**
 * Prepare les pistes retenues SANS faire attendre personne.
 *
 * Le lecteur demande d'abord la liste, puis le fichier : deux allers-retours en
 * serie. Mesure en local, a froid : 635 ms pour la liste, 647 ms pour le fichier —
 * plus le reseau, environ 1,7 s avant que le texte n'apparaisse a l'ecran, alors que
 * la video, elle, a demarre tout de suite.
 *
 * Or on connait deja l'URL au moment de repondre la liste. On lance donc la
 * preparation pendant que le lecteur lit notre reponse : quand il reclame le fichier,
 * il est pret. Le cout est nul pour lui, et le travail aurait ete fait de toute façon.
 */
export function prechauffer(urls: string[]): void {
  for (const url of urls.slice(0, 2)) {
    void preparerVtt(url).catch(() => null);
  }
}

/** Sert une piste convertie en VTT. Le jeton signe evite le proxy ouvert. */
export async function handleServeSub(req: Request, res: Response): Promise<void> {
  const raw = String(req.params.token || '').replace(/\.vtt$/i, '');

  // Adresse stable (forme actuelle), ou ancien jeton chiffre — des liens en circulation
  // en portent encore, et une piste qui cesserait de s'afficher apres une mise a jour
  // serait un mauvais echange.
  const url = get<string>(`subid:${raw}`) ?? decodeToken(raw)?.v;
  if (!url) {
    res.status(404).type('text/plain').send('piste inconnue ou expiree');
    return;
  }

  const corps = await preparerVtt(url);
  if (!corps) {
    res.status(502).type('text/plain').send('sous-titre injoignable ou illisible');
    return;
  }

  servirVtt(res, corps);
}

/** En-tetes communs aux deux chemins, pour qu'ils ne divergent jamais. */
function servirVtt(res: Response, corps: string): void {
  res.set('Content-Type', 'text/vtt; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(corps);
}
