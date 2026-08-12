// Ressource /meta — servie UNIQUEMENT pour nos ids `kkh:`.
//
// Pour les ids IMDb, Cinemeta fait deja le travail (et le fait mieux) : repondre a sa
// place n'apporterait rien et risquerait de degrader les fiches. On ne repond donc que
// la ou personne d'autre ne peut : les dramas absents d'IMDb, que notre catalogue est
// le seul a exposer.

import type { Request, Response } from 'express';
import { parseStremioId } from '../core/ids';
import { drama } from '../sources/direct/kisskh/client';
import { countryToLanguage } from '../core/meta';

export async function handleMeta(req: Request, res: Response): Promise<void> {
  const parsed = parseStremioId(String(req.params.id || ''));
  if (!parsed || parsed.kind !== 'kkh') {
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
