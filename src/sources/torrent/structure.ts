// Lecture de la STRUCTURE d'un nom de release : saison, episode, pack.
//
// POURQUOI CE FICHIER SEPARE. Il encapsule `parsium-media`, la seule dependance de ce
// projet qui ne soit pas indispensable. Tout ce qui la concerne tient ici : si elle
// devait partir, seule cette fonction change, et `release.ts` — qui porte le savoir
// metier — n'est pas touche.
//
// CE QU'ON LUI CONFIE, ET POURQUOI. Mesure sur 122 titres reels recoltes sur les neuf
// trackers : zero desaccord de saison, dix desaccords d'episode, et Parsium avait
// raison DIX FOIS SUR DIX. Toujours le meme cas, la forme francaise des sites de
// telechargement direct :
//
//     « Crash Landing on You - Saison 1 Épisode 4 - [VOSTFR] — Rapidgator »
//
// Notre expression reguliere lisait la saison mais ratait l'episode, et comme
// l'episode etait nul, `isPackRelease` classait l'episode isole en PACK DE SAISON.
// Consequence en production : mauvaise etiquette, et jugement de taille fausse
// puisqu'on juge un pack a l'episode.
//
// CE QU'ON NE LUI CONFIE PAS : LA LANGUE. Sur les memes 122 titres, 106 concordances
// et seize ecarts allant tous dans le meme sens — nous MULTI, lui VO. Sur un « MULTi »
// nu il signale `isMultiLanguage` mais n'affirme aucune langue. C'est defendable en
// general (« MULTi » n'implique pas le francais partout), c'est faux pour la scene FR
// qui est notre public : lui confier la langue ferait perdre l'etiquette francaise a
// 13 % des releases reelles. `languageOf` reste seul juge.
//
// COUT. `createCachedParser()` : 0,020 ms par titre, soit ~4 ms pour deux cents
// candidats. Le parseur NU coute 0,44 ms — vingt fois plus. Toujours passer par le
// parseur a cache.

import { createCachedParser } from 'parsium-media';

/**
 * Un seul parseur pour tout le processus : son cache interne est ce qui rend le cout
 * negligeable, et il serait perdu a chaque appel si on en creait un par release.
 */
const parseur = createCachedParser();

export interface Structure {
  season: number | null;
  episode: number | null;
  /**
   * Numero ABSOLU, quand la release en porte un.
   *
   * Les donghua et les series asiatiques circulent souvent sans saison : « Battle
   * Through the Heavens - 156 ». On savait deja lire le nombre ; on ignorait qu'il
   * comptait depuis le debut de la serie, et une demande S02E01 ne pouvait donc pas y
   * correspondre. C'est ce que ce champ rend possible.
   */
  absolu: number | null;
  /** Saison entiere, ou serie complete. */
  isPack: boolean;
  /** Serie ENTIERE — plus large qu'un pack de saison. */
  isCompleteSeries: boolean;
}

/**
 * Lit la structure, ou rend `null` si la lecture n'apprend rien d'exploitable.
 *
 * Ne leve jamais : une dependance qui echoue ne doit pas faire tomber une recherche.
 * L'appelant retombe alors sur nos expressions regulieres.
 */
export function structureDe(nom: string): Structure | null {
  try {
    const p = parseur.parse(nom) as {
      seasons?: number[];
      episodes?: number[];
      absoluteEpisode?: number;
      isSeasonPack?: boolean;
      isCompleteSeries?: boolean;
    };
    if (!p) return null;

    const season = Array.isArray(p.seasons) && p.seasons.length > 0 ? p.seasons[0] : null;
    const episode = Array.isArray(p.episodes) && p.episodes.length > 0 ? p.episodes[0] : null;
    const absolu = typeof p.absoluteEpisode === 'number' ? p.absoluteEpisode : null;
    const isCompleteSeries = p.isCompleteSeries === true;

    return {
      season,
      episode,
      absolu,
      isPack: p.isSeasonPack === true || isCompleteSeries,
      isCompleteSeries,
    };
  } catch {
    return null;
  }
}
