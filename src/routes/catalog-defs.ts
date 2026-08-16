// Definition des catalogues, partagee entre le manifeste et le handler.
//
// Ils s'appuient sur `DramaList/List`, qui est OUVERT : le catalogue de l'addon ne
// depend donc ni d'une cle, ni de la signature kkey. Meme le jour ou KissKH casse la
// lecture, on continue de proposer une navigation complete.
//
// Enumerations relevees le 2026-08-12 (cf. docs/kisskh-api.md).

export interface CatalogDef {
  id: string;
  name: string;
  type: 'series' | 'movie';
  /** Parametres de DramaList/List (KissKH). */
  country?: number;
  kkType?: number;
  order?: number;
  /** Pays d'origine chez TMDB (`KR`, `CN`...). Absent = tout le creneau asiatique. */
  pays?: string;
  /** Ordre chez TMDB. Par defaut : popularite. */
  tri?: 'popularite' | 'nouveautes';
}

// « Episodes recents » a disparu : c'est une notion propre a KissKH, que TMDB ne sait
// pas rendre — et une rubrique qui ne se remplit que chez la moitie des utilisateurs
// vaut moins qu'une rubrique de moins.
export const COUNTRY_CATALOGS: CatalogDef[] = [
  { id: 'dramallyu-popular', name: 'Dramas populaires', type: 'series', order: 1 },
  { id: 'dramallyu-new', name: 'Nouveautes', type: 'series', order: 3, tri: 'nouveautes' },
  { id: 'dramallyu-kr', name: 'Coree du Sud', type: 'series', country: 2, order: 1, pays: 'KR' },
  { id: 'dramallyu-cn', name: 'Chine', type: 'series', country: 1, order: 1, pays: 'CN' },
  { id: 'dramallyu-jp', name: 'Japon', type: 'series', country: 3, order: 1, pays: 'JP' },
  { id: 'dramallyu-th', name: 'Thailande', type: 'series', country: 5, order: 1, pays: 'TH' },
  { id: 'dramallyu-tw', name: 'Taiwan', type: 'series', country: 7, order: 1, pays: 'TW' },
  { id: 'dramallyu-movies', name: 'Films asiatiques', type: 'movie', kkType: 2, order: 1 },
];

export function findCatalog(id: string): CatalogDef | undefined {
  return COUNTRY_CATALOGS.find((c) => c.id === id);
}
