// Ressource /catalog — la navigation dans les dramas.
//
// PROPOSEE UNIQUEMENT A QUI A POSE UNE CLE TMDB. Le catalogue n'avait pas ete demande,
// et il coutait cher : alimente par la seule `DramaList/List` de KissKH, il se vidait
// entierement des que cette source devenait injoignable. Un hebergeur dont le
// fournisseur est bloque voyait « empty content » sur les neuf rubriques et en
// concluait, raisonnablement, que l'addon etait casse.
//
// Le manifeste ne l'annonce donc plus par defaut (cf. `manifest.ts`), et la regle est
// repetee ici : une installation dont le manifeste en cache annonce encore les
// rubriques n'ira pas interroger une source dont son proprietaire n'a pas voulu.
//
// DEUX SOURCES, dans cet ordre. TMDB d'abord : c'est lui qui justifie l'existence du
// catalogue, et il ne partage pas le sort de KissKH qu'un hebergeur peut se voir
// refuser. KissKH en repli — il ne demande aucune cle, et connait des dramas absents
// de TMDB.

import type { Request, Response } from 'express';
import { parseConfig } from '../core/config';
import { findCatalog } from './catalog-defs';
import { list, search, type KkSearchItem } from '../sources/direct/kisskh/client';
import { catalogueTmdb, type FicheTmdb } from '../sources/meta/tmdb-catalogue';

const PAGE_SIZE = 40;

export interface MetaPreview {
  id: string;
  type: 'series' | 'movie';
  name: string;
  poster?: string;
  posterShape?: 'poster' | 'landscape';
  description?: string;
  /** Annee, affichee par Stremio sous le titre. */
  releaseInfo?: string;
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

/** Une fiche TMDB au format attendu par Stremio. */
function apercuTmdb(f: FicheTmdb, type: 'series' | 'movie'): MetaPreview {
  return {
    // `parseStremioId` lit deja cette forme, et `/meta` la sert depuis ce changement.
    id: `tmdb:${f.id}`,
    type,
    name: f.nom,
    poster: f.affiche,
    description: f.description,
    releaseInfo: f.annee,
  };
}

export async function handleCatalog(req: Request, res: Response): Promise<void> {
  const def = findCatalog(String(req.params.id || ''));
  if (!def) {
    res.json({ metas: [] });
    return;
  }

  // Le catalogue n'est propose qu'a qui a pose une cle TMDB (cf. le manifeste, qui ne
  // l'annonce pas autrement). La regle est repetee ici pour que les installations
  // anterieures — dont le manifeste en cache annonce encore les rubriques — cessent
  // d'interroger une source dont elles n'ont pas voulu.
  const config = parseConfig((req.params as Record<string, string>).config ?? null);
  if (!config.catalogue || !config.tmdb) {
    res.json({ metas: [] });
    return;
  }

  try {
    const extra = parseExtra(req);
    const query = extra.search?.trim();
    const skip = Number(extra.skip || 0) || 0;
    const page = Math.floor(skip / PAGE_SIZE) + 1;

    // TMDB D'ABORD. C'est lui qui justifie l'existence du catalogue : metadonnees
    // soignees, affiches, synopsis francais — et surtout il ne partage pas le sort de
    // KissKH, qu'un hebergeur peut se voir refuser. KissKH reste en repli : il ne
    // demande aucune cle et rend des dramas absents de TMDB.
    const parTmdb = await catalogueTmdb({
      type: def.type,
      pays: def.pays,
      tri: def.tri,
      page,
      cle: config.tmdb,
      recherche: query,
    });

    if (parTmdb && parTmdb.length > 0) {
      res.json({ metas: parTmdb.map((f) => apercuTmdb(f, def.type)) });
      return;
    }
    if (parTmdb === null) {
      console.error(`[Catalog] ${req.params.id} : TMDB n'a pas repondu — on tente KissKH.`);
    }

    if (query) {
      const found = await search(query);
      // La recherche KissKH ne sait pas filtrer par type : on rend tout, en laissant
      // le type du catalogue interroge. Filtrer ici couperait des resultats valides
      // (beaucoup de fiches « film » sont typees serie chez eux).
      res.json({ metas: found.slice(0, PAGE_SIZE).map((i) => toPreview(i, def.type)) });
      return;
    }

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
