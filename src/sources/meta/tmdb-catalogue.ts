// Catalogue alimente par TMDB.
//
// POURQUOI IL EXISTE. Le catalogue reposait sur la seule `DramaList/List` de KissKH.
// Cette source devient injoignable — un hebergeur dont le fournisseur est bloque, par
// exemple — et les neuf rubriques se vident d'un coup. Vecu : l'addon paraissait casse
// de bout en bout alors que ses flux fonctionnaient.
//
// TMDB n'a pas ce defaut et fait mieux le travail : metadonnees soignees, affiches,
// synopsis francais, popularite reelle. Sa contrepartie est d'exiger une cle — c'est
// precisement pourquoi le catalogue n'est propose qu'a qui en a pose une.
//
// LES IDENTIFIANTS SONT `tmdb:<id>`. `discover` ne rend pas l'identifiant IMDb, et
// l'obtenir demanderait un appel PAR FICHE — quarante appels pour une page. On emet
// donc l'identifiant TMDB, que `parseStremioId` sait deja lire et que notre `/meta`
// sert desormais.

import { getJson } from '../../core/http';
import { cached } from '../../core/cache';

const TMDB = 'https://api.themoviedb.org/3';
const TTL_MS = 3 * 60 * 60 * 1000;

/** Les langues du creneau. `|` vaut OU chez TMDB. */
const LANGUES_ASIE = 'ko|zh|ja|th';

export interface FicheTmdb {
  id: number;
  nom: string;
  annee?: string;
  affiche?: string;
  description?: string;
  note?: number;
}

interface BrutTmdb {
  id?: number;
  name?: string;
  title?: string;
  first_air_date?: string;
  release_date?: string;
  poster_path?: string | null;
  overview?: string;
  vote_average?: number;
}

export interface RequeteCatalogue {
  type: 'series' | 'movie';
  /** Pays d'origine (`KR`, `CN`...) — plus precis que la langue pour une rubrique pays. */
  pays?: string;
  /** Ordre : popularite par defaut, ou nouveautes. */
  tri?: 'popularite' | 'nouveautes';
  page: number;
  cle: string;
  /** Recherche libre. Quand elle est fournie, le reste est ignore. */
  recherche?: string;
}

function fiche(b: BrutTmdb): FicheTmdb | null {
  const nom = b.name || b.title;
  if (!b.id || !nom) return null;
  const date = b.first_air_date || b.release_date || '';
  return {
    id: b.id,
    nom,
    annee: date.slice(0, 4) || undefined,
    affiche: b.poster_path ? `https://image.tmdb.org/t/p/w500${b.poster_path}` : undefined,
    description: b.overview || undefined,
    note: typeof b.vote_average === 'number' && b.vote_average > 0 ? b.vote_average : undefined,
  };
}

/** Exporte pour etre testable : c'est ici que se jouent le pays et les bornes. */
export function urlCatalogue(r: RequeteCatalogue): string {
  const chemin = r.type === 'series' ? 'tv' : 'movie';
  const commun = `api_key=${encodeURIComponent(r.cle)}&language=fr-FR&page=${r.page}`;

  if (r.recherche) {
    return `${TMDB}/search/${chemin}?${commun}&query=${encodeURIComponent(r.recherche)}`;
  }

  const p = new URLSearchParams();
  // Le pays d'origine cible mieux qu'une langue : le mandarin est parle a Taiwan comme
  // en Chine continentale, et une rubrique « Taiwan » qui rend Pekin n'a pas de sens.
  if (r.pays) p.set('with_origin_country', r.pays);
  else p.set('with_original_language', LANGUES_ASIE);

  if (r.tri === 'nouveautes') {
    p.set('sort_by', r.type === 'series' ? 'first_air_date.desc' : 'release_date.desc');
    // Sans borne haute, TMDB remonte des fiches annoncees pour dans deux ans.
    const aujourdhui = new Date().toISOString().slice(0, 10);
    p.set(r.type === 'series' ? 'first_air_date.lte' : 'release_date.lte', aujourdhui);
    // Et sans plancher de votes, on recolte des fiches vides creees la veille.
    p.set('vote_count.gte', '5');
  } else {
    p.set('sort_by', 'popularity.desc');
  }

  return `${TMDB}/discover/${chemin}?${commun}&${p.toString()}`;
}

/** Un titre qu'un lecteur francophone ne peut pas lire ni retenir. */
function illisible(nom: string): boolean {
  // Hangul, han, kana, thai. On ne juge pas les accents ni la ponctuation.
  return /[\uac00-\ud7af\u4e00-\u9fff\u3040-\u30ff\u0e00-\u0e7f]/.test(nom);
}

/**
 * Une page de catalogue. Rend `null` si l'APPEL a echoue — jamais une liste vide,
 * qu'on ne saurait pas distinguer d'un catalogue reellement sans resultat.
 *
 * DEUX LANGUES, quand il le faut. TMDB rend le titre francais s'il existe — « Le Jeu
 * de la dame » —, sinon le titre ORIGINAL. Sur une page de dramas coreens, la moitie
 * revient donc en hangul : illisible, et introuvable pour qui cherche. On redemande
 * alors la meme page en anglais et on comble les trous. Un appel de plus PAR PAGE,
 * jamais par fiche, et seulement quand un titre l'exige.
 */
export async function catalogueTmdb(r: RequeteCatalogue): Promise<FicheTmdb[] | null> {
  const adresse = urlCatalogue(r);
  // La cle N'ENTRE PAS dans la cle de cache : deux utilisateurs qui demandent la meme
  // rubrique partagent le resultat, et aucun secret ne se retrouve ecrit sur disque.
  const empreinte = adresse.replace(/api_key=[^&]*/, 'api_key=x');

  return cached<FicheTmdb[] | null>(
    `tmdbcat:v1:${empreinte}`,
    TTL_MS,
    async () => {
      const data = await getJson<{ results?: BrutTmdb[] }>(adresse, { timeoutMs: 12000 });
      if (!data || !Array.isArray(data.results)) return null;

      const fiches = data.results.map(fiche).filter((f): f is FicheTmdb => f !== null);
      if (!fiches.some((f) => illisible(f.nom))) return fiches;

      const enAnglais = await getJson<{ results?: BrutTmdb[] }>(
        adresse.replace('language=fr-FR', 'language=en-US'),
        { timeoutMs: 12000 },
      );
      if (!enAnglais || !Array.isArray(enAnglais.results)) return fiches;

      const parId = new Map(enAnglais.results.map((b) => [b.id, b.name || b.title]));
      return fiches.map((f) => {
        if (!illisible(f.nom)) return f;
        const anglais = parId.get(f.id);
        // Si l'anglais est lui aussi dans l'ecriture d'origine, on garde ce qu'on a :
        // un titre original vaut mieux qu'un champ vide.
        return anglais && !illisible(anglais) ? { ...f, nom: anglais } : f;
      });
    },
    {
      scope: 'tmdbcat',
      echec: (v) => v === null,
      shouldCache: (v) => v !== null && v.length > 0,
      negativeTtlMs: 30 * 60 * 1000,
    },
  );
}

export interface DetailTmdb {
  nom: string;
  annee?: string;
  affiche?: string;
  fond?: string;
  description?: string;
  genres: string[];
  /** Saisons reelles, hors « saison 0 » (les hors-serie, que Stremio n'attend pas ici). */
  saisons: { numero: number; episodes: number }[];
}

/**
 * Fiche detaillee, pour /meta. Un seul appel : les saisons y figurent avec leur compte
 * d'episodes, ce qui suffit a construire la liste. Aller chercher les titres reels
 * demanderait un appel par saison — cher, pour un affichage que Stremio remplace de
 * toute facon par « Episode N » quand le titre manque.
 */
export async function ficheTmdb(
  id: string,
  type: 'movie' | 'series',
  cle: string,
): Promise<DetailTmdb | null> {
  const chemin = type === 'series' ? 'tv' : 'movie';
  return cached<DetailTmdb | null>(
    `tmdbfiche:v1:${chemin}:${id}`,
    7 * 24 * 60 * 60 * 1000,
    async () => {
      const d = await getJson<{
        name?: string;
        title?: string;
        first_air_date?: string;
        release_date?: string;
        poster_path?: string | null;
        backdrop_path?: string | null;
        overview?: string;
        genres?: { name?: string }[];
        seasons?: { season_number?: number; episode_count?: number }[];
      }>(`${TMDB}/${chemin}/${encodeURIComponent(id)}?api_key=${encodeURIComponent(cle)}&language=fr-FR`, {
        timeoutMs: 12000,
      });
      if (!d) return null;
      const nom = d.name || d.title;
      if (!nom) return null;

      return {
        nom,
        annee: (d.first_air_date || d.release_date || '').slice(0, 4) || undefined,
        affiche: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : undefined,
        fond: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : undefined,
        description: d.overview || undefined,
        genres: (d.genres ?? []).map((g) => g.name).filter((n): n is string => Boolean(n)),
        saisons: (d.seasons ?? [])
          .filter((s) => (s.season_number ?? 0) > 0 && (s.episode_count ?? 0) > 0)
          .map((s) => ({ numero: s.season_number as number, episodes: s.episode_count as number })),
      };
    },
    { scope: 'tmdbcat', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
}
