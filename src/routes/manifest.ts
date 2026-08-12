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

import { COUNTRY_CATALOGS } from './catalog-defs';

export const ADDON_ID = 'ovh.loostick.dramallyu';
export const ADDON_VERSION = '0.1.0';

export interface Manifest {
  id: string;
  version: string;
  name: string;
  description: string;
  logo?: string;
  resources: string[];
  types: string[];
  idPrefixes: string[];
  catalogs: { type: string; id: string; name: string; extra?: { name: string; isRequired?: boolean }[] }[];
  behaviorHints: { configurable: boolean; configurationRequired: boolean };
}

export function getManifest(): Manifest {
  const catalogs = COUNTRY_CATALOGS.map((c) => ({
    type: c.type,
    id: c.id,
    name: c.name,
    extra: [{ name: 'skip' }, { name: 'search' }],
  }));

  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: 'Dramallyu',
    description:
      'Dramas asiatiques (coreens, chinois, thailandais, japonais) et films : agregateur multi-sources ' +
      'avec sous-titres francais en priorite. Sources directes sans aucune cle, plus torrents et DDL ' +
      'via votre propre compte AllDebrid ou TorBox.',
    resources: ['stream', 'subtitles', 'catalog', 'meta'],
    types: ['series', 'movie'],
    // On accepte les trois provenances : Cinemeta/AIOStreams (tt), un catalogue TMDB
    // tiers (tmdb:), et notre propre catalogue (kkh:) pour les dramas absents d'IMDb.
    idPrefixes: ['tt', 'kkh:', 'tmdb:'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}
