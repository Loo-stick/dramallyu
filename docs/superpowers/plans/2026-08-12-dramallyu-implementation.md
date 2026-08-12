# Dramallyu — Plan d'implémentation (bout en bout)

> **Pour un exécutant agentique :** ce plan est exécuté **inline** dans la session de
> la nuit du 2026-08-12, pas via sous-agents. Les étapes utilisent des cases à cocher.

**Goal:** Un addon Stremio *et Nuvio* communautaire, dédié aux dramas asiatiques,
agrégeant trois piliers de sources (direct, torrent, DDL) vers un résolveur debrid
unifié, avec page admin (opérateur) et page configure (par-utilisateur).

**Architecture:** Express 4 + TypeScript strict, protocole Stremio écrit à la main.
Toutes les sources implémentent un contrat `Source` unique et sont interrogées en
fan-out parallèle sous budget de temps dur. Aucun débridage pendant `/stream` : les
entrées pointent vers `/resolve/<jeton>` qui redirige en 302 au moment du Play.

**Tech Stack:** Node 22, TypeScript 5 strict, Express 4, better-sqlite3, axios,
`node:test` + tsx, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-12-dramallyu-design.md`

## Global Constraints

- **Port 7020** (7001/7002/7011/7012 déjà pris sur l'hôte).
- **RAM** : `mem_limit: 512m` **et** `memswap_limit: 512m` (jamais de swap — cause
  des deux gels de nipogi-srv). Caches bornés, jamais de `Map` non bornée.
- **Interdiction absolue** : regex à quantificateurs bornés sur du JS minifié
  (8 Go mesurés sur 883 Ko). Sur le bundle KissKH : `indexOf` littéral + `slice`.
- **Aucune clé globale.** Toutes les clés (debrid, trackers, TMDB) sont
  par-utilisateur. L'opérateur ne fournit ni ne prête aucun accès.
- **Nuvio** : sous-titres **uniquement** via la ressource `/subtitles`, codes
  **ISO 639-2** (`fre`, `eng`), URLs pointant vers nos endpoints `text/vtt`.
  Ne **jamais** mettre aussi `subtitles` sur l'objet Stream (Nuvio empile).
- **AIOStreams** : `/manifest.json` jamais gaté, config dans le chemin,
  `behaviorHints.filename` / `videoSize` / `bingeGroup` renseignés, réponse `/stream`
  sous 8 s.
- Fichiers **< ~400 lignes**. `index.ts` = câblage seul.
- Commits fréquents, en français, sans co-auteur (dépôt perso).

---

## Lot A — Socle

### Task A1 : Scaffold
**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`,
`Dockerfile`, `docker-compose.yml`, `src/index.ts`, `README.md`
- [ ] `git init`, npm init, deps : express@4, axios, better-sqlite3, express-rate-limit
- [ ] `tsconfig` strict, target ES2022, outDir `dist`
- [ ] `src/index.ts` : express, `trust proxy`, `GET /api/stats` (non gaté)
- [ ] Dockerfile (copie `dist/` pré-buildé), compose avec les garde-fous RAM
- [ ] **Vérif** : `npm run build && npm start` → `curl localhost:7020/api/stats` = 200
- [ ] Commit

### Task A2 : `src/core/config.ts` — config par-utilisateur
**Produces:** `UserConfig`, `parseConfig(s?: string): UserConfig`, `encodeConfig(c): string`
- [ ] Test : encode→decode round-trip ; base64url **et** base64 standard acceptés ;
      chaîne invalide → défauts ; champs inconnus ignorés
- [ ] Impl : base64url sans padding à l'écriture, tolérant à la lecture
- [ ] Champs : `ad`, `tb`, `c411`, `tr4ker`, `tmdb`, `subLangs` (déf. `['fre','eng']`),
      `excludeQualities` (déf. `[]`), `sources` (déf. `[]` = toutes), `sortBy`
- [ ] Commit

### Task A3 : `src/core/cache.ts` + `src/core/endpoint-config.ts`
Greffes de LooStream (`src/cache.ts`, `src/endpoint-config.ts`).
- [ ] Copier `cache.ts` en **supprimant** l'import `./settings` et `effectiveTtl`
      (couplage inutile ici) ; garder scope / `shouldCache` / `negativeTtlMs`
- [ ] Copier `endpoint-config.ts` tel quel (hot-reload `fs.watch`)
- [ ] Test : `cached()` mémorise, expire, ne mémorise pas un résultat vide
- [ ] Commit

### Task A4 : `src/core/settings.ts` — réglages opérateur
- [ ] `config/runtime-settings.json` hot-reload : sources on/off, budget de fan-out
- [ ] **Ne pas reproduire le piège LooStream** (cache in-process non invalidé) :
      relire le fichier via `endpoint-config`, pas de cache manuel
- [ ] Commit

### Task A5 : `src/core/ids.ts` + `src/core/meta.ts`
**Produces:** `parseStremioId(id)`, `resolveTitle(query, userConfig)`
- [ ] Test : `tt123:2:5` → `{imdb, season:2, episode:5}` ; `kkh:3749:1:3` ; `tmdb:1396`
- [ ] `meta.ts` : Cinemeta (`v3-cinemeta.strem.io`, **sans clé**) → titre, année,
      langue d'origine ; TMDB **optionnel** si l'utilisateur a une clé
- [ ] Commit

### Task A6 : `src/core/matching.ts`
- [ ] Greffe de `loostream/src/matching.ts` (token-set + année)
- [ ] Ajout : `confirmByTmdbImage()` — égalité exacte du chemin d'image TMDB porté
      par la vignette KissKH (niveau 2, seulement si clé TMDB présente)
- [ ] Commit

---

## Lot B — KissKH (le challenge)

### Task B1 : SPIKE `kkey` — **aller au bout**
- [ ] Récupérer l'URL de `main.<hash>.js` depuis la page d'accueil
- [ ] Télécharger sur disque (scratchpad), **jamais** de regex bornée dessus
- [ ] Localiser par `indexOf` littéral : `kkey`, `charCodeAt`, `fromCharCode`, `btoa`
- [ ] Découper la fonction, l'isoler, l'évaluer en `node:vm`
- [ ] **Critère de succès** : `Episode/<id>.png?...&kkey=…` renvoie 200 + du JSON vidéo
- [ ] Consigner l'algo trouvé dans `docs/kkey.md`
- [ ] Commit

### Task B2 : `src/sources/direct/kisskh/client.ts`
- [ ] `search(q)`, `drama(id)`, `list(params)` typés + cache
- [ ] Fixtures enregistrées pour les tests (pas d'appel réseau en test)
- [ ] Commit

### Task B3 : `src/sources/direct/kisskh/kkey.ts`
- [ ] Extraction auto + bac à sable `node:vm` + cache
- [ ] Ré-extraction sur salve de 403 (auto-réparation)
- [ ] Filet `config/kisskh-kkey.json` hot-reload
- [ ] Commit

### Task B4 : source KissKH (contrat `Source`) + sous-titres
- [ ] `search()` → `Candidate[]` (flux HLS direct)
- [ ] `subs()` → pistes, **FR en tête**
- [ ] Commit

---

## Lot C — VoirDrama

### Task C1 : `src/extractors/` — greffe
- [ ] Porter `loostream/src/extractors/index.ts` + `unpack.ts` (+ leurs tests)
- [ ] Découper si > 400 lignes par famille d'hôtes
- [ ] Commit

### Task C2 : `src/sources/direct/voirdrama.ts`
- [ ] Porter le scraper (API Movix par `tmdbId` + repli scraping Madara)
- [ ] L'adapter au contrat `Source`
- [ ] Commit

---

## Lot D — Debrid

### Task D1 : `src/debrid/types.ts` + `alldebrid.ts` + `torbox.ts`
- [ ] Portage de `wastream/wastream/debrid/{alldebrid,torbox}.py`
- [ ] Retry HTTP sur 429/500/502/503/504 (repris de `base.py`)
- [ ] TorBox : `checkCached` par lot. AllDebrid : **pas** de faux badge « instantané »
- [ ] Commit

### Task D2 : `src/debrid/resolver.ts` + `src/routes/resolve.ts`
- [ ] Jeton signé (HMAC) encodant source + hash/lien + fichier visé
- [ ] `/resolve/:token` → 302 vers le lien débridé
- [ ] **Routage** : AllDebrid via `mfp-light`, TorBox en direct
- [ ] Commit

---

## Lot E — Torrents

### Task E1 : `src/sources/torrent/torznab.ts` — client générique
- [ ] Parse XML Torznab, extrait `infohash` / magnet / seeders / taille
- [ ] `apikey` **jamais** écrite en cache (réinjectée au service, cf. `_strip_apikey`)
- [ ] Recherche par `tmdbid` quand disponible, sinon par titre
- [ ] Instancie C411, Tr4ker, relais Ygg depuis la config admin
- [ ] Commit

### Task E2 : `src/sources/torrent/nyaa.ts`
- [ ] Recherche catégorie Live Action, parse RSS, hash depuis le magnet
- [ ] Détection VOSTFR/VF dans le titre de release
- [ ] Commit

---

## Lot F — DDL

### Task F1 : `src/sources/ddl/zonetelechargement.ts`
- [ ] Portage depuis `loostream/src/scrapers/zonetelechargement.ts`
- [ ] Commit

### Task F2 : `src/sources/ddl/wawacity.ts`
- [ ] Écriture complète (aucun code existant), domaines en hot-reload
- [ ] Commit

---

## Lot G — Agrégation

### Task G1 : `src/sources/types.ts` + `src/core/registry.ts`
- [ ] Contrat `Source`, enregistrement, activation par réglages **et** config user
- [ ] Fan-out parallèle sous `AbortSignal.timeout` (budget dur)
- [ ] Test : une source lente n'empêche pas les rapides de répondre
- [ ] Commit

### Task G2 : `src/routes/stream.ts`
- [ ] Dédup, tri par préférences, formatage Stremio + `behaviorHints`
- [ ] Test : réponse sous budget, jamais de débridage synchrone
- [ ] Commit

### Task G3 : `src/core/proxy.ts` — greffe
- [ ] Allowlist SSRF + `h_*` + `Range` (repris de LooStream)
- [ ] Commit

---

## Lot H — Sous-titres

### Task H1 : `src/subs/convert.ts`
- [ ] SRT → VTT, ASS/SSA → VTT (greffe LooStream), gzip transparent
- [ ] Test sur échantillons des trois formats
- [ ] Commit

### Task H2 : `src/routes/subtitles.ts` + `src/subs/aggregate.ts`
- [ ] KissKH + OpenSubtitles legacy + fichiers du dossier debrid
- [ ] **FR d'abord**, ISO 639-2, servis en `text/vtt` par nos endpoints
- [ ] Variante `/:id/:extra.json` (Stremio ajoute videoHash/videoSize)
- [ ] Commit

---

## Lot I — Catalogue

### Task I1 : `src/routes/catalog.ts`
- [ ] Catalogues Populaire / Récents / Films / par pays, + recherche
- [ ] Commit

### Task I2 : `src/routes/meta.ts`
- [ ] `/meta` pour les ids `kkh:` uniquement, depuis `Drama/<id>`
- [ ] Commit

---

## Lot J — Interfaces

### Task J1 : `src/web/configure.html`
- [ ] Toutes les clés par-utilisateur, avertissement franc sur le base64
- [ ] Lien d'installation Stremio **et** Nuvio
- [ ] Commit

### Task J2 : `src/web/admin.html` + `src/routes/admin.ts`
- [ ] Session cookie, sources on/off, domaines à chaud, santé, stats, purge cache
- [ ] **Pas de codage par couleur seule** (utilisateur daltonien) : formes et libellés
- [ ] Commit

---

## Lot K — Livraison

### Task K1 : Tests complets + `tsc --strict` vert
### Task K2 : Docker build + déploiement local sur :7020
### Task K3 : README + vérification bout en bout Stremio **et** Nuvio

---

## Vérification finale

- `npm test` vert, `npm run build` sans erreur
- `curl -s localhost:7020/<config64>/stream/series/tt<id>:1:1.json` < 8 s
- Installation réelle dans Stremio : lecture d'un épisode + sous-titres FR
- Installation réelle dans Nuvio : mêmes vérifications
- Ajout comme addon `custom` dans AIOStreams : flux parsés correctement
- `docker stats` : rester loin des 512 Mo
