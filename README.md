# Dramallyu

Addon **Stremio et Nuvio** dedie aux **dramas asiatiques** — coreens, chinois,
thailandais, japonais — et aux films du meme creneau, avec les **sous-titres francais
en priorite**.

Il agrege trois familles de sources vers un resolveur debrid unique, et il est
utilisable **sans aucune cle** : les sources directes suffisent a regarder.

## Disclaimer / Avertissement

**IMPORTANT — VEUILLEZ LIRE ATTENTIVEMENT**

Ce projet est fourni **uniquement a des fins educatives et de recherche**. L'auteur et
les contributeurs de ce projet :

- **NE SONT PAS RESPONSABLES** de l'utilisation qui est faite de ce logiciel
- **NE CAUTIONNENT PAS** le piratage ou toute violation des droits d'auteur
- **NE FOURNISSENT AUCUN CONTENU** — ce logiciel n'heberge, ne stocke et ne diffuse
  aucune oeuvre. Il ne fait qu'agreger des liens disponibles publiquement sur Internet
  et des metadonnees publiques, et rediriger vers des services tiers que l'utilisateur
  a lui-meme configures avec ses propres comptes.
- **NE GARANTISSENT PAS** le fonctionnement, la disponibilite ou la legalite des
  sources externes
- **DECLINENT TOUTE RESPONSABILITE** quant aux consequences legales de l'utilisation de
  ce logiciel

**L'utilisateur est seul responsable** de verifier la legalite de l'utilisation de ce
logiciel dans sa juridiction et d'obtenir les autorisations necessaires pour acceder
aux contenus.

Aucune cle, aucun compte et aucun identifiant ne sont fournis par ce projet : chaque
utilisateur configure les siens, et l'operateur d'une instance n'en detient aucun.

Ce projet peut cesser de fonctionner a tout moment sans preavis si les sources externes
changent ou ferment.

---

## Ce qu'il fait

| Pilier | Sources | Cle requise |
|---|---|---|
| Direct | KissKH, VoirDrama | aucune |
| Torrent | Nyaa, C411, Tr4ker | debrideur (+ cle du tracker, sauf Nyaa) |
| DDL | Zone-Telechargement, Wawacity | debrideur |

- **Catalogue** de 12 700 fiches, navigable par pays, avec recherche.
- **Sous-titres** agreges (source + OpenSubtitles), francais en tete, servis en VTT.
- **Compatible AIOStreams** : manifeste jamais protege, config dans le chemin,
  reponse `/stream` sous un budget de 8 secondes.

## Installation par un utilisateur

Ouvrir `/configure`, remplir ce qu'on veut (ou rien), generer le lien.

La page **teste les cles** (AllDebrid, TorBox, TMDB, C411, Tr4ker) avant l'installation
— le test passe par le serveur, ces API ne repondant pas aux appels d'un navigateur.
Elle affiche surtout, **en direct, lesquelles des sept sources tourneront reellement**
pour la configuration en cours : la reponse vient du meme `planSources` que le moteur,
donc la page ne peut pas promettre une source qui ne s'executerait pas.

- **Stremio** : bouton d'installation, ou coller le lien dans la recherche d'addons.
- **Nuvio** : « Addons &rarr; Ajouter une extension », coller le lien.
  Si une version precedente est deja installee, la **desinstaller d'abord** : Nuvio met
  en cache la liste des ressources d'un addon et ne verrait pas les sous-titres autrement.

## Deploiement par l'operateur

```bash
cp .env.example .env
# Renseigner au minimum TOKEN_SECRET (et ADMIN_PASSWORD pour avoir la page admin) :
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

docker compose up -d --build
docker compose logs -f dramallyu
```

L'addon ecoute sur le port **7020**. Derriere un reverse-proxy, `trust proxy` est
actif : les en-tetes `X-Forwarded-*` suffisent a construire les liens absolus.

### Deployer depuis l'image publiee

L'image est construite par GitHub Actions a chaque poussee sur `master` (`latest`) et a
chaque etiquette `vX.Y.Z` (`X.Y.Z` et `X.Y`). Rien a compiler sur la machine cible :

```sh
docker compose pull && docker compose up -d
```

`build: .` reste declare dans `docker-compose.yml` : `docker compose up -d --build`
construit localement quand on developpe.

### Le dossier `config/` doit etre accessible en ecriture

Le conteneur tourne sous l'utilisateur `node`, dont **l'uid vaut 1000** dans les images
Node. Or `docker-compose.yml` monte `./config` depuis l'hote, et un montage REMPLACE le
dossier de l'image — les permissions posees a la construction avec. Il faut donc que
`config/` soit accessible en ecriture a l'uid 1000 :

```sh
sudo chown -R 1000:1000 config
```

Sans cela, l'addon s'arrete au demarrage sur `SQLITE_CANTOPEN`. Il vous le dira en
clair, avec la commande a passer et l'uid constate — mais autant le savoir avant.

Cela ne se voit pas quand l'utilisateur de l'hote a lui-meme l'uid 1000, ce qui est le
cas du premier compte cree sur la plupart des distributions.

### Developpement

```bash
npm install
npm run dev      # tsx, sources a chaud
npm test         # node:test
npm run build    # tsc --strict, le vrai garde-fou statique
```

## Principes de conception

**Aucune cle globale.** L'operateur ne fournit et ne prete aucun acces : chaque
utilisateur met ses propres cles debrid, trackers et TMDB dans sa configuration. La
page d'administration pilote la *disponibilite* (quelle source tourne, a quelle
adresse), jamais les *acces*.

**La configuration est chiffree dans le lien** (AES-256-GCM, cle derivee de
`TOKEN_SECRET`). Ce que ca change, exactement : le lien reste un **laissez-passer** —
qui le detient peut lire des flux via le compte debrid de son proprietaire, puisque
c'est le serveur qui dechiffre — mais les cles n'en sont plus **extractibles**. Un lien
colle dans un salon Discord pour demander de l'aide n'est plus une cle AllDebrid
reutilisable ailleurs, decodable en trois secondes. Consequence a connaitre : changer
`TOKEN_SECRET` invalide tous les liens d'installation existants.

**Aucun debridage pendant `/stream`.** Les entrees pointent vers `/resolve/<jeton>`,
et le debrideur n'est sollicite qu'au moment du Play. C'est ce qui tient le budget de
8 secondes — au-dela, AIOStreams coupe la source et l'utilisateur voit une liste vide.

**Pas de faux badge « instantane ».** TorBox sait dire si un torrent est en cache, et
on l'affiche. AllDebrid n'expose plus d'API fiable pour ca : ses entrees sont marquees
« a debrider » plutot que d'annoncer une disponibilite qu'on ne peut pas verifier.

**La qualite trie, elle ne filtre pas.** Un seuil de qualite parait raisonnable
jusqu'au jour ou il ampute une VF en 480p — c'est-a-dire exactement ce que cherchait
l'utilisateur. L'exclusion existe, elle est optionnelle et vide par defaut.

**Accessibilite.** Aucune information n'est portee par la couleur seule dans les
interfaces : chaque etat porte un symbole et un mot.

## Documentation

- [`docs/kkey.md`](docs/kkey.md) — le reverse de la signature KissKH, et comment le
  refaire quand ils changeront d'algorithme.
- [`docs/kisskh-api.md`](docs/kisskh-api.md) — l'API KissKH, endpoints et enumerations.
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — le design valide.
- [`docs/superpowers/plans/`](docs/superpowers/plans/) — le plan d'implementation.

## Etat des sources au 2026-08-12

| Source | Etat |
|---|---|
| KissKH | verifiee en reel — flux + 7 pistes de sous-titres dont le francais |
| VoirDrama | verifiee en reel — apporte notamment de la VF |
| Nyaa | analyseur valide sur le flux RSS reel |
| C411 / Tr4ker / Ygg | implementes (Torznab) — **non verifiables sans compte** |
| Zone-Telechargement | verifiee en reel — recherche DLE en POST, liens proteges zoneurs |
| Wawacity | verifiee en reel sur **wawacity.estate** (domaine suivi automatiquement) — 16 candidats VF et VOSTFR sur un episode, hebergeurs debridables uniquement |

## Synchronisation automatique des domaines

Les sites DDL francais changent de domaine plusieurs fois par an, et l'ancien devient
generalement un **domaine parque** : il repond 200 avec de la publicite, si bien qu'une
simple sonde de disponibilite ne detecte pas la bascule. C'est exactement ce qui rendait
Wawacity muet.

`src/core/domain-sync.ts` lit l'apercu public du canal Telegram officiel de chaque site
(`t.me/s/<canal>`, sans compte ni cle) et y trouve l'adresse courante dans les
metadonnees Open Graph :

| Site | Canal | Metadonnee |
|---|---|---|
| Wawacity | `Wawacityofficiel` | `og:title` → « Wawacity.estate » |
| Zone-Telechargement | `zone_telechargement_officielle` | `og:description` → « ...de https://zone-telechargement.org/ » |

Les canaux ont ete trouves par **auto-decouverte** : ils sont publies en lien sur les
sites eux-memes. Verification toutes les 6 h, plus un declenchement manuel depuis
l'admin.

**Garde-fou** : un domaine annonce n'est jamais ecrit sans avoir ete teste — joignable
ET non parque. Un canal pirate ou un message mal formule ne peut donc pas casser une
source qui fonctionnait.

## Limites connues

**Pistes de sous-titres chiffrees (KissKH).** Certaines pistes ont leurs repliques
chiffrees (extensions `.txt` / `.txt1`). Le dechiffrement est implemente — on execute
les fonctions du site avec CryptoJS, meme parti pris que pour le `kkey` — mais il n'a
**pas pu etre verifie** : sur douze dramas recents sondes, toutes les pistes etaient en
`.srt`, donc en clair. Le code est defensif : il ne se declenche que sur une extension
inhabituelle et refuse de servir si le resultat n'est pas plausible.

**Indexeurs Torznab.** C411 et Tr4ker sont implementes mais non verifiables sans un
compte sur chacun. La page /configure sait en revanche dire si une cle est acceptee :
le test interroge `t=search`, qui authentifie — et surtout pas `t=caps`, qui repond
200 a n'importe quelle cle inventee.

**Le relais YggTorrent a ete retire** le 2026-08-13 : `u2p.anhkagi.net` repond 403
depuis ce serveur (ni cle acceptee, ni IP autorisee), et stream-fusion — d'ou venait
l'adresse — n'a aucun mecanisme de cle pour lui. Le faire revenir tient en trois
lignes : une entree dans `settings.torznab`, une ligne dans `torznabSources()`, un
champ dans la page.

## Remerciements

**[Parsium](https://github.com/NepiRaw/Parsium)**, de **NepiRaw** — le parseur de noms
de release qui lit la structure de nos candidats : saison, episode, pack de saison, et
surtout le numero ABSOLU des donghua, qu'on ne savait pas reconnaitre. Il a aussi
corrige un defaut qu'on ne se connaissait pas : la forme francaise des sites de
telechargement direct (« Titre - Saison 1 Épisode 4 ») dont nous rations l'episode, si
bien qu'un episode isole etait annonce comme une saison entiere. Sur quarante titres
reels de K-drama, l'episode passe de 0 a 33 correctement lus et les faux packs de 36 a
3. Zero dependance, MIT, et rapide au point que le brancher ne coute rien.

**[MediaFlow Proxy](https://github.com/mhdzumair/mediaflow-proxy)**, de **mhdzumair** —
que chaque utilisateur peut declarer dans sa configuration pour faire sortir ses
lectures par une seule adresse IP.

**Cinemeta**, le catalogue de metadonnees de Stremio — public, sans cle, et sans lequel
l'addon ne serait pas utilisable par quelqu'un qui n'a rien a configurer.

## Licence

MIT License — voir le fichier [LICENSE](LICENSE).

---

**En utilisant ce logiciel, vous acceptez ces conditions et assumez l'entiere
responsabilite de son utilisation.**
