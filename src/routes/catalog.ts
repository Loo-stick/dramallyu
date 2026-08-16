// Ressource /catalog — la navigation dans les dramas.
//
// Elle repose sur `DramaList/List`, endpoint OUVERT : le catalogue ne depend ni d'une
// cle utilisateur, ni de la signature kkey. C'est deliberé — meme le jour ou KissKH
// casse la lecture, l'addon reste un annuaire de dramas utilisable, et les flux
// arrivent alors des piliers torrent et DDL.

import type { Request, Response } from 'express';
import { findCatalog } from './catalog-defs';
import { list, search, type KkSearchItem } from '../sources/direct/kisskh/client';

const PAGE_SIZE = 40;

export interface MetaPreview {
  id: string;
  type: 'series' | 'movie';
  name: string;
  poster?: string;
  posterShape?: 'poster' | 'landscape';
  description?: string;
}

function toPreview(item: KkSearchItem, type: 'series' | 'movie'): MetaPreview {
  return {
    // Id maison : c'est notre ressource /meta qui repondra. Les dramas asiatiques
    // sont souvent absents d'IMDb, donc emettre un tt<id> ici reviendrait a proposer
    // des fiches vides.
    id: `kkh:${item.id}`,
    type,
    name: item.title,
    poster: item.thumbnail,
    // Les vignettes KissKH sont au format 16/9 (ce sont des images TMDB de type
    // backdrop) : l'annoncer evite que Stremio les etire en format affiche.
    posterShape: 'landscape',
  };
}

/** Stremio transmet ses parametres soit en query, soit dans un segment "a=b&c=d". */
function parseExtra(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (typeof v === 'string') out[k] = v;
  }
  const segment = (req.params as Record<string, string>).extra;
  if (segment) {
    for (const pair of decodeURIComponent(segment).split('&')) {
      const eq = pair.indexOf('=');
      if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return out;
}

export async function handleCatalog(req: Request, res: Response): Promise<void> {
  const def = findCatalog(String(req.params.id || ''));
  if (!def) {
    res.json({ metas: [] });
    return;
  }

  try {
    const extra = parseExtra(req);
    const query = extra.search?.trim();

    if (query) {
      const found = await search(query);
      // La recherche KissKH ne sait pas filtrer par type : on rend tout, en laissant
      // le type du catalogue interroge. Filtrer ici couperait des resultats valides
      // (beaucoup de fiches « film » sont typees serie chez eux).
      res.json({ metas: found.slice(0, PAGE_SIZE).map((i) => toPreview(i, def.type)) });
      return;
    }

    const skip = Number(extra.skip || 0) || 0;
    const page = Math.floor(skip / PAGE_SIZE) + 1;

    const result = await list({
      page,
      pageSize: PAGE_SIZE,
      country: def.country ?? 0,
      type: def.kkType ?? 0,
      order: def.order ?? 1,
    });

    // UN CATALOGUE VIDE DOIT DIRE POURQUOI. Stremio affiche « empty content » dans les
    // deux cas, et sans journal l'hebergeur n'a rien pour trancher : le tenir informe
    // est la seule facon de distinguer une source injoignable d'une source qui n'a
    // rien. Un ami a passe une soiree sur cette question, faute de cette ligne.
    if (result === null) {
      console.error(
        `[Catalog] ${req.params.id} : KissKH n'a pas repondu — catalogue vide. ` +
          "Verifiez que l'hebergeur peut le joindre (certains bloquent les IP de centres de donnees).",
      );
      res.json({ metas: [] });
      return;
    }
    if (result.data.length === 0) {
      console.log(`[Catalog] ${req.params.id} : KissKH a repondu, 0 entree`);
    }

    res.json({ metas: result.data.map((i) => toPreview(i, def.type)) });
  } catch (e) {
    console.error(`[Catalog] echec ${req.params.id}: ${(e as Error).message}`);
    res.json({ metas: [] });
  }
}
