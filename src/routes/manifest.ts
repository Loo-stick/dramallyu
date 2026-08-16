// Manifeste Stremio.
//
// Deux exigences non negociables :
//
//  - JAMAIS gate par une cle d'acces. LooStream a un ACCESS_KEY qui repond 401 sur
//    /manifest.json ; ici ce serait fatal, car AIOStreams ne peut pas agreger un
//    addon dont il n'arrive pas a lire le manifeste.
//  - `resources` inclut `subtitles`. Nuvio ignore les sous-titres attaches a un objet
//    Stream : la ressource est le SEUL mecanisme fiable. Attention, modifier cette
//    liste oblige les utilisateurs de Nuvio a REINSTALLER l'addon (il met en cache
//    la liste des ressources).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { UserConfig } from '../core/config';

import { COUNTRY_CATALOGS } from './catalog-defs';

export const ADDON_ID = 'ovh.loostick.dramallyu';

/**
 * Version annoncee a Stremio, LUE dans package.json.
 *
 * Elle y etait recopiee a la main, et elle est restee a `0.1.0` pendant que le paquet
 * passait en 1.1.0 : la seule version que voient Stremio et AIOStreams ne disait donc
 * rien de ce qui tournait, et personne ne pouvait constater l'ecart depuis le client.
 * Meme piege que la liste des secrets et celle des reglages a repeupler — une copie
 * tenue de memoire a cote de sa source de verite finit toujours par diverger.
 *
 * Lu a l'execution plutot qu'importe : `package.json` est hors de `rootDir`, donc un
 * `import` le ferait entrer dans la compilation et casserait l'arborescence de `dist`.
 * `__dirname` vaut `dist/routes` dans l'image et `src/routes` sous tsx — deux crans
 * au-dessus, on tombe sur la racine du projet dans les deux cas. Pas `import.meta` :
 * la compilation vise CommonJS et le refuse.
 */
export const ADDON_VERSION: string = (
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
    version: string;
  }
).version;

export interface Manifest {
  id: string;
  version: string;
  name: string;
  description: string;
  logo?: string;
  background?: string;
  resources: string[];
  types: string[];
  idPrefixes: string[];
  catalogs: { type: string; id: string; name: string; extra?: { name: string; isRequired?: boolean }[] }[];
  behaviorHints: { configurable: boolean; configurationRequired: boolean };
}

/**
 * Manifeste.
 *
 * `baseUrl` sert a construire l'adresse ABSOLUE du logo : Stremio l'affiche depuis son
 * interface, pas depuis notre domaine, et un chemin relatif y pointerait sur lui-meme.
 * Il reste facultatif — un manifeste sans logo est valide, et mieux vaut un addon sans
 * illustration qu'un addon illisible.
 */
export function getManifest(baseUrl?: string, config?: UserConfig): Manifest {
  // LE CATALOGUE N'EXISTE QUE POUR QUI A UNE CLE TMDB.
  //
  // Il n'a jamais ete demande, et il coutait cher : adosse a la seule source KissKH,
  // il se vidait entierement des que celle-ci devenait injoignable — un hebergeur dont
  // le fournisseur est bloque voyait « empty content » sur les neuf rubriques et
  // concluait, raisonnablement, que l'addon etait casse.
  //
  // Ne pas ANNONCER de catalogue est plus honnete que d'en annoncer un vide : Stremio
  // n'affiche alors aucune rubrique, et l'addon se presente pour ce qu'il est —
  // un fournisseur de flux et de sous-titres.
  // DEUX conditions : l'utilisateur l'a demande, ET il a la cle qui l'alimente.
  // Annoncer des rubriques que TMDB ne pourra pas remplir ramenerait le probleme
  // qu'on vient de corriger.
  const avecCatalogue = Boolean(config?.catalogue && config?.tmdb);
  const catalogs = avecCatalogue
    ? COUNTRY_CATALOGS.map((c) => ({
        type: c.type,
        id: c.id,
        name: c.name,
        extra: [{ name: 'skip' }, { name: 'search' }],
      }))
    : [];

  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: 'Dramallyu',
    ...(baseUrl ? { logo: `${baseUrl}/logo.png`, background: `${baseUrl}/fond.jpg` } : {}),
    description:
      'Dramas asiatiques (coreens, chinois, thailandais, japonais) et films : agregateur multi-sources ' +
      'avec sous-titres francais en priorite. Sources directes sans aucune cle, plus torrents et DDL ' +
      'via votre propre compte AllDebrid ou TorBox.',
    // `catalog` et `meta` ne servent QUE le catalogue : les annoncer sans lui ferait
    // interroger deux ressources qui ne repondraient rien.
    resources: avecCatalogue ? ['stream', 'subtitles', 'catalog', 'meta'] : ['stream', 'subtitles'],
    types: ['series', 'movie'],
    // On accepte les trois provenances : Cinemeta/AIOStreams (tt), un catalogue TMDB
    // tiers (tmdb:), et notre propre catalogue (kkh:) pour les dramas absents d'IMDb.
    idPrefixes: ['tt', 'kkh:', 'tmdb:'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}
