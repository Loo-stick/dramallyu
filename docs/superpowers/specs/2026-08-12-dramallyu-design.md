# Dramallyu — addon Stremio communautaire, dramas asiatiques

## Contexte

Créneau non couvert : les dramas coréens/chinois/thaï/japonais n'existent quasiment
pas dans l'écosystème Stremio FR. LooStream les effleure (`voirdrama.ts` seul) et
n'est pas fait pour ça. On construit un addon **dédié, communautaire** — l'opérateur
c'est toi, mais chaque utilisateur installe avec **sa** config (ses clés debrid, sa
langue, ses sources).

Trois piliers de sources convergent vers **un résolveur debrid unifié** :

1. **Direct** — KissKH (puis d'autres), sans aucune clé → l'addon est utile dès
   l'installation, même à qui n'a pas de debrid. C'est ce qui le rend adoptable.
2. **Torrents** — trackers en Torznab direct → hash → debrid.
3. **DDL** — Zone-Téléchargement, Wawacity → lien hébergeur → debrid.

Contrainte transverse : **compatible AIOStreams** et rapide (AIOStreams coupe une
source lente). Tout le design de la réponse `/stream` en découle.

## Décisions déjà tranchées

| Sujet | Décision |
|---|---|
| Archi | Scaffold **neuf**, avec greffes ciblées de modules LooStream éprouvés. Aucun import de `index.ts`. |
| Debrid | Clients **TS maison** AllDebrid + TorBox (portés de wastream). Pas de StremThru. |
| Torrents | **Scrapers directs** — un client Torznab générique (C411, Tr4ker, relais Ygg) + Nyaa bespoke. |
| Sources v1 | Nyaa.si, C411, Tr4ker, Zone-Téléchargement, Wawacity. |
| Identifiants | **IMDb prioritaire**, repli `kkh:<id>` avec ressource `/meta` maison. `/stream` accepte `tt`, `tmdb:`, `kkh:`. |
| Ordre | Tranche verticale KissKH d'abord (le `kkey` est le risque n°1 → testé tôt). |
| Nom | `Dramallyu` — repo `stremio-addon-dramallyu`, domaine `dramallyu.loostick.ovh`. |
| Clés | **Aucune clé globale.** Chaque utilisateur configure les siennes (debrid, trackers, TMDB). L'opérateur ne paie ni ne prête rien. |
| Métadonnées | **Cinemeta** (sans clé) par défaut ; TMDB en enrichissement optionnel par-utilisateur. |

## Ce qui a été vérifié sur pièce (12/08/2026)

- KissKH `Search`, `Drama/<id>` et **`DramaList/List?page=&type=&country=&status=&order=&pageSize=`**
  (browse paginé, `totalCount` 2010 sur un seul filtre) : **HTTP 200, aucune signature**.
  → le catalogue entier est accessible sans toucher au `kkey`.
- `Episode/<id>.png` et `Sub/<id>` : **403 confirmé** sans `kkey`. Le mur ne concerne
  que la lecture et les sous-titres.
- `Drama/<id>` ne porte **aucun identifiant externe** (ni imdb ni tmdb) → matching à faire.
- **Levier de matching** : les vignettes KissKH sont des chemins TMDB bruts
  (`media.themoviedb.org/t/p/w1000_and_h563_face/vOgGdN0vBOnhtjbe3i86SQRdQA1.jpg`).
  Le chemin de fichier est **l'identifiant d'image TMDB lui-même** → on confirme un
  candidat par **égalité exacte de chemin** contre `/images` de TMDB. C'est une preuve,
  pas une heuristique : ça règle le problème des titres asiatiques romanisés.
- C411 (`c411.org/api`), Tr4ker (`tr4ker.net/torznab`) et le relais Ygg
  (`u2p.anhkagi.net/torznab`) parlent **tous les trois Torznab** → un seul client.

## Architecture

Node 22 + TypeScript strict, Express 4, protocole Stremio écrit à la main (comme
LooStream : `stremio-addon-sdk` ne sert à rien ici). `better-sqlite3` pour les caches
persistants. Règle de découpe : **aucun fichier au-dessus de ~400 lignes**, `index.ts`
réduit au câblage (l'anti-modèle à ne pas reproduire est `loostream/src/index.ts`, 146 Ko).

```
src/
  index.ts              câblage express + montage des routers, ~80 lignes
  routes/               manifest.ts  stream.ts  subtitles.ts  catalog.ts  meta.ts
                        resolve.ts   admin.ts   configure.ts  api.ts
  core/
    config.ts           config par-user base64 <-> objet, validation, valeurs par défaut
    settings.ts         réglages opérateur (fichier JSON, hot-reload)
    registry.ts         registre des sources : enregistrement, on/off, ordre, budget
    ids.ts              tt / tmdb: / kkh: -> identité canonique
    meta.ts             Cinemeta (sans clé) + TMDB optionnel : titres, année, imdb
    matching.ts         [greffe LooStream] + confirmation par chemin d'image TMDB
    cache.ts            [greffe LooStream] LRU bornée + SQLite
    proxy.ts            [greffe LooStream] allowlist SSRF, en-têtes h_*, Range
    endpoint-config.ts  [greffe LooStream] domaines rotatifs, fs.watch
  sources/
    types.ts            interface Source (contrat unique des 3 piliers)
    direct/kisskh/      client.ts  kkey.ts  catalog.ts  subs.ts
    torrent/torznab.ts  client générique -> C411, Tr4ker, relais Ygg
    torrent/nyaa.ts     scraper dédié (pas Torznab)
    ddl/zonetelechargement.ts   ddl/wawacity.ts
  debrid/
    types.ts  alldebrid.ts  torbox.ts  resolver.ts
  subs/
    aggregate.ts  opensubtitles.ts  convert.ts   (ASS/SRT -> VTT)
  web/                  configure.html  admin.html  login.html
config/                 bind-monté, éditable à chaud (domaines, réglages, sources)
```

### Le contrat `Source` (le cœur)

Les trois piliers implémentent **la même interface**, ce qui rend le pilier 3 aussi
facile à étendre que le 1 :

```ts
interface Source {
  id: string;                       // 'kisskh' | 'nyaa' | 'c411' | 'zt' ...
  kind: 'direct' | 'torrent' | 'ddl';
  enabled(settings, userConfig): boolean;
  search(query: Query, deadline: AbortSignal): Promise<Candidate[]>;
}
// Candidate = { title, quality, language, size?, seeders?, magnetOrHash?, ddlUrl?,
//               directUrl?, subs?[], sourceId }
```

`Query` porte `{ imdbId?, tmdbId?, kkhId?, titles[], year, season?, episode?, type }`.
Chaque source consomme ce qu'elle sait exploiter (Torznab prend `tmdbid`, Nyaa prend
les titres, KissKH prend `kkhId`).

### Réponse `/stream` : rapide par construction

C'est le point qui conditionne la compatibilité AIOStreams. **On ne débride jamais
pendant `/stream`.**

1. Résolution d'identité (cache SQLite, quasi toujours un hit).
2. Fan-out **parallèle** sur les sources activées, avec un **budget global dur**
   (~8 s, `AbortSignal.timeout`) : une source lente est abandonnée, elle ne retarde
   pas les autres. Cache stale-while-revalidate par-dessus.
3. Dédup + tri selon les préférences utilisateur (greffe `prefs.ts`).
4. Chaque entrée renvoie une URL vers **notre** `/resolve/<jeton>` — le débridage
   (unlock AllDebrid / TorBox) se fait **au moment du Play**, en 302. C'est le
   comportement de Comet/Torrentio, et la seule façon de rester sous les délais.

Nuance honnête sur le cache debrid : TorBox expose un check-cache par lot, on
l'utilise et on marque « instantané ». **AllDebrid n'a plus d'API d'instant-availability
fiable** — on n'invente pas un badge : ces entrées sont marquées « à débrider »,
et `/resolve` ajoute le magnet puis interroge brièvement. Pas de promesse fausse.

### Résolveur debrid unifié

```ts
interface DebridService {
  name: 'alldebrid' | 'torbox';
  checkCached(hashes: string[]): Promise<Map<string, boolean>>;   // TorBox seul
  resolveTorrent(magnetOrHash, fileHint): Promise<Resolved>;
  resolveDdl(link): Promise<Resolved>;                            // 1fichier, uptobox
  listFiles(id): Promise<FileEntry[]>;                            // sert aux sous-titres
}
```
Portage de `wastream/wastream/debrid/alldebrid.py` (278 l.) et `torbox.py` (670 l.) —
la logique de retry HTTP (`base.py`, codes 429/500/502/503/504) est reprise telle quelle.
**Règle de routage conservée** (mémoire `debrid_routing_policy`) : les liens AllDebrid
repartent via `mfp-light` (compte familial partagé → éviter le bannissement multi-IP),
TorBox en direct.

### KissKH et le `kkey` — le risque, et son filet

Stratégie en quatre temps, avec une porte de sortie à chaque étage :

1. Récupérer `main.<hash>.js` depuis la page d'accueil.
2. **Localiser la fonction par `indexOf` littéral + `slice`** sur des ancres
   (`kkey`, `charCodeAt`, `fromCharCode`, `btoa`). ⚠️ **Jamais de regex à
   quantificateurs bornés sur ce bundle** — CLAUDE.md documente 8 Go consommés sur
   883 Ko de JS minifié, c'est exactement ce profil de fichier.
3. Évaluer la fonction isolée dans un bac à sable **`node:vm`** (contexte sans `fs`,
   sans réseau), résultat mis en cache. Ré-extraction automatique quand une salve de
   403 est détectée → l'addon se répare seul quand KissKH change son algo.
4. **Filet** : `config/kisskh-kkey.json`, hot-reload via `endpoint-config.ts`.
   Si l'extraction automatique échoue, tu colles une fonction valide dans le fichier
   et ça repart **sans redéploiement**.

**Timebox du spike.** Si le `kkey` ne tombe pas dans l'effort prévu, KissKH est
dégradé en **catalogue seul** — ce qui reste sa contribution la plus précieuse (le
browse est ouvert, vérifié) — et les flux viennent des piliers torrent/DDL. Le projet
ne dépend pas du succès du reverse.

### Sous-titres

Ressource `/subtitles/:type/:id.json`, agrégée depuis trois gisements, **FR d'abord**
puis l'ordre de langues de l'utilisateur, puis le reste (multi conservé) :

1. **KissKH** — `Sub/<epId>` (signé `kkey`), multi-langues.
2. **OpenSubtitles legacy** — greffe de `loostream/src/subtitles.ts` : API
   `rest.opensubtitles.org`, **sans clé ni quota** (surtout pas l'API v1).
3. **Fichiers du dossier debrid** — après résolution, `listFiles()` expose les
   `.srt`/`.ass` livrés avec la release (les teams VOSTFR les joignent presque
   toujours). Servis par notre endpoint, convertis en VTT.

Conversion ASS/SSA → VTT reprise de LooStream (`subtitleToVtt`).

### Catalogue et métadonnées — **zéro clé requise**

Conséquence directe de « pas de clés globales » : rien de ce qui est partagé entre
utilisateurs ne doit dépendre d'une clé. Le catalogue tient donc entièrement sur des
sources ouvertes, et TMDB devient un bonus individuel.

- Catalogues : **Populaire**, **Récents**, **Films**, et un par pays (Corée, Chine,
  Thaïlande, Japon) — alimentés par `DramaList/List` (non signé) + recherche.
- **`Drama/<id>` suffit à peupler le catalogue et `/meta`** : il porte `title`,
  `description`, `releaseDate`, `country`, `type`, `episodes` et une `thumbnail`
  directement affichable. Aucune clé, aucun quota.
- **Sens inverse (une requête arrive en `tt<id>`)** : résolu par **Cinemeta**
  (`v3-cinemeta.strem.io/meta/:type/:id.json`) — public, sans clé, natif Stremio →
  titre + année, ce dont les sources ont besoin pour chercher.
- **TMDB, optionnel et par-utilisateur** : titres et synopsis **FR**, meilleure
  couverture des titres asiatiques, et `external_ids` pour obtenir l'imdb d'une
  fiche `kkh:`. Fourni → on enrichit ; absent → on sert les données KissKH brutes.
- Le mapping `kkh ↔ tmdb ↔ imdb` est **mis en cache en SQLite et partagé** : il se
  réchauffe grâce aux utilisateurs qui ont posé une clé, et profite ensuite à tous
  sans jamais réutiliser leur clé. Rafraîchi par rotation, jamais en rebuild massif
  (leçon `loobox_catalog_rebuild_oom`).
- Ressource `/meta` servie **uniquement** pour les ids `kkh:` (le reste est couvert
  par Cinemeta chez le client).

### Configure (par-user) et Admin (opérateur)

**`/configure`** → base64(JSON) dans le chemin d'installation :
clés AllDebrid / TorBox, **clés trackers C411 / Tr4ker**, **clé TMDB optionnelle**,
ordre des langues de sous-titres (FR par défaut), préférences de qualité (tri, pas
couperet — cf. l'historique de sur-filtrage documenté dans `prefs.ts`), sélection
des sources.

**Toutes les clés sont par-utilisateur, sans exception** — l'opérateur n'en fournit
aucune. Une source dont l'utilisateur n'a pas la clé est simplement ignorée dans son
fan-out : elle n'échoue pas, elle ne ralentit rien, et la page `/configure` indique
clairement ce qu'il perd. Un utilisateur sans aucune clé garde KissKH et le catalogue
complets — l'addon reste utile à qui n'a rien.

> ⚠️ **À dire franchement sur la page** : la config base64 dans l'URL est *encodée*,
> pas *chiffrée*. Quiconque voit l'URL d'installation voit les clés debrid — qui
> donnent accès à un compte payant. C'est le modèle de LooStream et d'AIOStreams v1,
> il est acceptable en HTTPS, mais il doit être écrit noir sur blanc sur `/configure`.
> Migration possible plus tard vers un stockage serveur (uuid + mot de passe).

**`/admin`** (session cookie, greffe LooStream) : sources on/off, domaines rotatifs
éditables à chaud (KissKH, trackers, sites DDL), **URLs de base des indexeurs Torznab**
(c411.org, tr4ker.net, u2p.anhkagi.net — la clé reste à l'utilisateur, l'adresse est
au serveur), santé des sources, statistiques, journaux, purge de cache.
L'admin ne détient **aucune clé** : il pilote la disponibilité, pas les accès.

### Docker et garde-fous hôte

`mem_limit: 512m` + `memswap_limit: 512m` (**jamais de swap** — c'est la cause des
deux gels de nipogi-srv), `config/` bind-monté, healthcheck sur `/api/stats` non gaté,
`trust proxy` pour les URLs absolues derrière Apache/Cloudflare. Caches LRU **bornés
en nombre d'entrées**, jamais de `Map` non bornée. Le téléchargement du bundle KissKH
est la seule opération lourde : plafonnée en taille et écrite sur disque, pas gardée
en mémoire.

## Compatibilité AIOStreams — liste de contrôle

- `/manifest.json` **jamais gaté** par une clé d'accès (le gate `ACCESS_KEY` de
  LooStream casserait l'agrégation) ; config dans le chemin.
- `behaviorHints` : `filename`, `videoSize`, `bingeGroup` renseignés → le parseur
  d'AIOStreams (`@viren070/parse-torrent-title`) extrait résolution/codec/langue.
- `name` / `description` au format standard (qualité, langue, taille, source, seeders).
- URLs de lecture **directes et web-ready** (le 302 est sur `/resolve`, pas sur le manifeste).
- Réponse `/stream` sous le budget de 8 s, toujours.

## Ordre de construction

| # | Étape | Sortie vérifiable |
|---|---|---|
| 0 | Scaffold + greffes + Docker + `/manifest.json` + `/configure` minimal | l'addon s'installe dans Stremio (0 flux) |
| 1 | **Spike `kkey`** (timeboxé) | un flux KissKH lu en ligne de commande, ou verdict « catalogue seul » |
| 2 | Source KissKH + `/stream` + `/subtitles` | **premier drama joué dans Stremio** |
| 3 | Résolveur debrid AllDebrid + TorBox + `/resolve` | un magnet connu → lien jouable |
| 4 | Torznab générique (C411, Tr4ker, Ygg) + Nyaa | flux torrent sur un drama réel |
| 5 | DDL : Zone-Téléchargement + Wawacity | flux DDL sur un titre FR réel |
| 6 | Catalogue + `/meta` + mapping SQLite | on parcourt les dramas dans Stremio |
| 7 | Admin + Configure complets | tout se pilote sans redéploiement |

Chaque étape est livrable et testable seule. TDD sur ce qui est pur et à risque de
régression : parsing Torznab, conversion de sous-titres, matching de titres, décodage
de config, préférences/tri. Les scrapers réseau sont testés sur fixtures enregistrées.

## Vérification

- `npm test` — unitaires (node:test + tsx, comme LooStream).
- `npm run build` — `tsc --strict` est le vrai garde-fou statique.
- Bout en bout, après chaque étape :
  `curl -s localhost:PORT/<config64>/stream/series/tt<id>:1:1.json | jq` — vérifier
  le **temps de réponse** (< 8 s) autant que le contenu.
- Installation réelle dans Stremio, lecture d'un épisode, sous-titres FR affichés.
- Ajout comme addon `custom` dans ton AIOStreams → les flux doivent apparaître
  parsés (résolution/langue reconnues), c'est le test de compatibilité qui compte.
- `docker stats` sur le conteneur pendant un fan-out : rester loin des 512 Mo.

## Point ouvert restant

**Sous-titres FR chez KissKH** : invérifiable avant le reverse du `kkey` (`Sub/<id>`
répond 403). Si KissKH n'a pas de FR, OpenSubtitles et les releases VOSTFR portent
seuls la promesse FR — d'où l'importance du pilier torrent. Ça se saura à l'étape 1.
