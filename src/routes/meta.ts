// Ressource /meta — servie pour nos ids `kkh:` et `tmdb:`.
//
// Pour les ids IMDb, Cinemeta fait deja le travail (et le fait mieux) : repondre a sa
// place n'apporterait rien et risquerait de degrader les fiches. On ne repond donc que
// la ou personne d'autre ne peut.
//
// `tmdb:` est arrive avec le catalogue TMDB. `discover` ne rend pas l'identifiant IMDb,
// et l'obtenir couterait un appel PAR FICHE — quarante pour une page. On emet donc
// l'identifiant TMDB, ce qui oblige a servir sa fiche ici : sans cela, cliquer une
// vignette du catalogue ouvrirait une page vide.

import type { Request, Response } from 'express';
import { parseStremioId } from '../core/ids';
import { drama } from '../sources/direct/kisskh/client';
import { countryToLanguage } from '../core/meta';
import { parseConfig } from '../core/config';
import { ficheTmdb } from '../sources/meta/tmdb-catalogue';

export async function handleMeta(req: Request, res: Response): Promise<void> {
  const parsed = parseStremioId(String(req.params.id || ''));
  if (!parsed) {
    res.json({ meta: null });
    return;
  }

  if (parsed.kind === 'tmdb') {
    const config = parseConfig((req.params as Record<string, string>).config ?? null);
    if (!config.tmdb) {
      res.json({ meta: null });
      return;
    }
    await metaTmdb(parsed.value, req.params.type === 'movie' ? 'movie' : 'series', config.tmdb, res);
    return;
  }

  if (parsed.kind !== 'kkh') {
    res.json({ meta: null });
    return;
  }

  try {
    const d = await drama(parsed.value);
    if (!d) {
      res.json({ meta: null });
      return;
    }

    const isMovie = d.type === 'Movie';
    const year = (d.releaseDate || '').slice(0, 4);

    // Stremio veut la liste des episodes dans `videos`, avec un id par episode qui
    // lui revient tel quel sur /stream — d'ou le format kkh:<drama>:<saison>:<numero>.
    const videos = isMovie
      ? undefined
      : d.episodes.map((ep) => ({
          id: `kkh:${d.id}:1:${ep.number}`,
          title: `Episode ${ep.number}`,
          season: 1,
          episode: ep.number,
          released: d.releaseDate || undefined,
          overview: ep.sub > 0 ? `${ep.sub} pistes de sous-titres disponibles` : undefined,
        }));

    res.json({
      meta: {
        id: `kkh:${d.id}`,
        type: isMovie ? 'movie' : 'series',
        name: d.title,
        poster: d.thumbnail,
        posterShape: 'landscape',
        background: d.thumbnail,
        description: d.description,
        releaseInfo: year || undefined,
        country: d.country,
        language: countryToLanguage(d.country),
        genres: [d.type, d.country].filter(Boolean),
        videos,
      },
    });
  } catch (e) {
    console.error(`[Meta] echec ${req.params.id}: ${(e as Error).message}`);
    res.json({ meta: null });
  }
}

/**
 * Fiche TMDB.
 *
 * La liste des episodes est construite a partir des SAISONS, qui donnent leur compte —
 * un seul appel. Recuperer les titres reels demanderait un appel par saison, pour un
 * gain faible : Stremio affiche « Episode 3 » de toute facon quand le titre manque, et
 * ce qui compte ici est que l'identifiant soit juste, puisque c'est lui qui repart
 * vers /stream.
 */
async function metaTmdb(
  id: string,
  type: 'movie' | 'series',
  cle: string,
  res: Response,
): Promise<void> {
  const f = await ficheTmdb(id, type, cle);
  if (!f) {
    // On distingue les deux : une fiche absente n'est pas une cle refusee.
    console.log(`[Meta] tmdb:${id} introuvable ou TMDB injoignable`);
    res.json({ meta: null });
    return;
  }

  const videos =
    type === 'movie'
      ? undefined
      : f.saisons.flatMap((s) =>
          Array.from({ length: s.episodes }, (_, i) => ({
            id: `tmdb:${id}:${s.numero}:${i + 1}`,
            title: `Episode ${i + 1}`,
            season: s.numero,
            episode: i + 1,
          })),
        );

  res.json({
    meta: {
      id: `tmdb:${id}`,
      type,
      name: f.nom,
      poster: f.affiche,
      background: f.fond,
      description: f.description,
      releaseInfo: f.annee,
      genres: f.genres,
      videos,
    },
  });
}
