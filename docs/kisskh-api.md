# API KissKH — releve du 2026-08-12

## Endpoints OUVERTS (aucune signature)

| Endpoint | Usage |
|---|---|
| `GET /api/DramaList/Search?q=<titre>&type=` | recherche par titre |
| `GET /api/DramaList/Drama/<id>?isq=false` | fiche + liste des episodes |
| `GET /api/DramaList/List?page=&pageSize=&type=&sub=&country=&status=&order=` | catalogue pagine |

## Endpoints SIGNES (`kkey`, cf. docs/kkey.md)

| Endpoint | Usage |
|---|---|
| `GET /api/DramaList/Episode/<epId>.png?err=false&ts=null&time=null&kkey=` | URL video (HLS) |
| `GET /api/Sub/<epId>?kkey=` | pistes de sous-titres |

## Enumerations (sondees une par une)

### `country`

| Valeur | Pays | Volume |
|---|---|---|
| 0 | tous | 12696 |
| 1 | Chine | 3480 |
| 2 | Coree du Sud | 2610 |
| 3 | Japon | 2836 |
| 4 | Hong Kong | 29 |
| 5 | Thailande | 1035 |
| 6 | Etats-Unis | 2127 |
| 7 | Taiwan | 150 |
| 8 | Philippines | 399 |
| 9 | Indonesie | 18 |

### `type`

| Valeur | Nature | Volume |
|---|---|---|
| 0 | tous | 12696 |
| 1 | series TV | 6610 |
| 2 | films | 1467 |
| 3 | anime | 2494 |
| 4 | « Hollywood » | 2125 |

### `order`

| Valeur | Tri observe |
|---|---|
| 1 | populaire (defaut du site) |
| 2 | mis a jour recemment |
| 3 | nouveautes (fiches 2026 en tete) |
| 4 | ordre interne, non expose dans l'addon |

## Forme des reponses

`Search` et `List` rendent des elements legers :

```json
{ "id": 3749, "title": "Squid Game Season 1", "episodesCount": 9,
  "thumbnail": "https://media.themoviedb.org/t/p/w1000_and_h563_face/zEiVQ...jpg" }
```

La **vignette est un chemin TMDB brut** : le nom de fichier est l'identifiant d'image
TMDB, ce qui permet de confirmer une correspondance de titre par egalite exacte
(cf. `confirmByTmdbImage` dans `src/core/matching.ts`).

`Drama/<id>` ajoute `description`, `releaseDate`, `country` (« South Korea »),
`status` (« Completed »), `type` (« TVSeries », « Movie », « Anime »), et
`episodes: [{ id, number, sub }]` — `sub` etant le NOMBRE de pistes de sous-titres.

**Aucun identifiant externe** (ni IMDb ni TMDB) n'est expose : la correspondance se
fait par titre, avec confirmation par l'image quand une cle TMDB est disponible.

## Piege

Les episodes arrivent en ordre **decroissant**. `client.ts` les retrie une fois pour
toutes a la lecture de la fiche.
