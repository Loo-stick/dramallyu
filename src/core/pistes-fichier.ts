// Langues des sous-titres LUES DANS LE FICHIER.
//
// C'est la seule source de verite, et la seule qui vaille pour ce que l'addon promet :
// des dramas asiatiques avec du francais. Le nom d'une release ment dans les deux sens,
// et seuls deux trackers sur sept publient leur MediaInfo.
//
// LE COUT, ET COMMENT IL EST TENU. Lire le fichier suppose une resolution chez le
// debrideur, puis une requete Range. C'est cher, donc :
//
//   - on ne mesure QUE ce qui est deja pret (present en cache chez le debrideur), pour
//     ne rien mettre en telechargement au seul motif de regarder son en-tete ;
//   - on ne mesure QUE les premiers de la liste, ceux que l'utilisateur verra ;
//   - le resultat est memorise SUR LE HASH pendant trois mois. Un hash designe un
//     fichier exact : ce qu'on en apprend reste vrai, et le cout n'est paye qu'une
//     fois pour tous les utilisateurs.
//
// La mesure n'allonge donc pas la reponse a la longue : au bout de quelques recherches
// sur un titre, tout ce qui compte est deja connu.

import { cached, get } from './cache';
import { languesSousTitres, estMatroska } from './mkv';
import { BROWSER_HEADERS } from './http';

/** Un hash designe un fichier exact : ce qu'on en apprend ne perime pas. */
const TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Un echec est souvent passager (lien expire, debrideur occupe) : on reessaiera. */
const TTL_ECHEC_MS = 6 * 60 * 60 * 1000;

/** Mesure faite sur des fichiers reels : l'en-tete tient largement dans 64 Ko. */
const FENETRE = 64 * 1024;

export interface MesurePistes {
  langues: string[];
  /** Faux quand on n'a pas su lire — a distinguer de « aucun sous-titre ». */
  lisible: boolean;
}

/**
 * Ce qu'on a DEJA mesure pour ce hash, sans le moindre appel reseau.
 *
 * Indispensable avant le filtrage : la mesure, elle, n'a lieu qu'apres le tri, sur les
 * premiers de la liste. Sans cette lecture prealable, un fichier dont on connait
 * pourtant les pistes serait filtre comme s'il etait inconnu — et le filtre
 * n'appliquerait jamais ce qu'on a appris.
 */
export function languesDejaConnues(infoHash?: string): string[] | undefined {
  if (!infoHash) return undefined;
  const v = get<MesurePistes>(`pistes:${infoHash.toLowerCase()}`);
  return v && v.lisible && v.langues.length > 0 ? v.langues : undefined;
}

async function lireEntete(url: string, signal?: AbortSignal): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: { ...BROWSER_HEADERS, Range: `bytes=0-${FENETRE - 1}` },
      signal,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Langues des sous-titres du fichier designe par ce hash.
 *
 * `obtenirUrl` n'est appele QUE si la reponse n'est pas deja connue : c'est lui qui
 * coute une resolution chez le debrideur, et on ne la paie pas deux fois.
 */
export async function languesDuFichier(
  infoHash: string,
  obtenirUrl: () => Promise<string | null>,
  signal?: AbortSignal,
): Promise<MesurePistes | null> {
  return cached<MesurePistes | null>(
    `pistes:${infoHash.toLowerCase()}`,
    TTL_MS,
    async () => {
      const url = await obtenirUrl();
      if (!url) return null;

      const buf = await lireEntete(url, signal);
      if (!buf || buf.length < 1024) return null;

      // Un conteneur qu'on ne sait pas lire (MP4, AVI) n'est pas un echec de mesure :
      // c'est un fichier dont on ne peut rien dire. On le memorise comme tel plutot
      // que de le resoudre a nouveau a chaque recherche.
      if (!estMatroska(buf)) return { langues: [], lisible: false };

      const langues = languesSousTitres(buf);
      // Tableau vide : l'element Tracks est au-dela de la fenetre, ou l'en-tete est
      // place en fin de fichier. On ne conclut PAS « aucun sous-titre ».
      return { langues, lisible: langues.length > 0 };
    },
    { scope: 'pistes', shouldCache: (v) => v !== null, negativeTtlMs: TTL_ECHEC_MS },
  );
}
