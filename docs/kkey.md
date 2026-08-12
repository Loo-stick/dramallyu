# KissKH — la signature `kkey`

Reverse effectue le 2026-08-12. Ce document existe pour qu'on puisse **refaire** le
travail quand KissKH changera son algorithme, sans repartir de zero.

## Le mur

Deux endpoints sont signes, et eux seuls :

```
GET /api/DramaList/Episode/<epId>.png?err=false&ts=null&time=null&kkey=<sig>
GET /api/Sub/<epId>?kkey=<sig>
```

Sans `kkey` : **403**. Tout le reste de l'API (recherche, fiche, catalogue paginé)
est ouvert.

## Le chemin suivi

1. `GET /` liste les scripts. Le bundle Angular `main.<hash>.js` (1,2 Mo) contient
   la **definition** de `GetEpisode(V,J,q,z,Me)` — qui **recoit** le kkey, ne le
   calcule pas. Impasse si on s'arrete la.
2. Les **appelants** sont dans un chunk paresseux. `runtime.<hash>.js` porte la table
   des chunks (`n.u = e => e + "." + {417:"...", 502:"...", ...}[e] + ".js"`).
   Le chunk **502** contient les appels.
3. Appel reel du lecteur :

```js
this.httpClientService.GetEpisode(
  this.EpisodeId, !1, null, null,
  this.cryptoService.key(this.EpisodeId, null, this.appVer, this.viGuid,
                         this.platformVer, this.appName /* x6 */)
)
```

   Et pour les sous-titres, **le meme appel avec `subGuid` au lieu de `viGuid`**.

4. Constantes, en clair dans le chunk 502 :

| Nom | Valeur au 2026-08-12 |
|---|---|
| `subGuid` | `VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp` |
| `viGuid` | `62f176f3bb1b5b8e70e39932ad34a0c7` |
| `appVer` | `2.8.10` |
| `platformVer` | `4830201` |
| `appName` | `kisskh` |

5. `cryptoService.key` (chunk 876) delegue a un global : `_0x54b991(...)`. Ce global
   n'est pas dans les chunks webpack — il est dans **`common.js`** (8 Ko), charge en
   `<script>` classique.

## L'algorithme

`_0x54b991(id, null, appVer, guid, platformVer, a, b, c, d, e, f)` :

1. Construit un tableau :
   `['', id, null, 'mg3c3b04ba', appVer, guid, platformVer, t48(a), t48(b.toLowerCase()), t48(c), d, e, f, '00', '']`
   ou `t48(x) = (x||'').substr(0,48)`.
2. Insere en position 1 un hash `h = (h<<5) - h + charCodeAt(i)` (djb2 modifie) de
   la jointure `'|'` du tableau.
3. Re-joint par `'|'`, applique un padding PKCS#7 sur 16 octets.
4. Chiffre en **AES-128, chainage CBC**, avec un key schedule **code en dur**
   (44 mots) et une IV en dur `[0x1504af3, 0x56e619cf, 0x2e42bba6, -0x73c08f07]`.
5. Rend l'hexadecimal **en majuscules**.

## Le point qui rend l'exploitation simple

Les six derniers parametres ne sont lus depuis `window.navigator` / `window.document`
**que s'ils valent `undefined`**. Or l'application passe explicitement `appName` aux
six. **La fonction est donc pure** : aucune dependance au navigateur, aucun timestamp,
aucun etat. On peut l'evaluer dans un bac a sable `node:vm` et l'appeler directement.

C'est ce que fait `src/sources/direct/kisskh/kkey.ts` : plutot que de reimplementer
l'AES obfusque (fragile a la moindre retouche de leur cote), **on execute leur propre
fonction**. Si KissKH change l'algorithme, on recupere simplement la nouvelle version
du fichier.

## Consequence sur les sous-titres

Le lecteur (chunk 876) revele que les sous-titres ne sont pas tous en clair :

```js
var ext = src.split('.').pop();
onload = ext !== 'srt'
  ? (ext === 'txt'  ? b1(cue.text)
  :  ext === 'txt1' ? b2(cue.text)
  :                   b3(cue.text))
  : rienAFaire;
```

- `.srt` → texte clair.
- `.txt` / `.txt1` / autre → **chiffre**, dechiffre cue par cue par `b1`/`b2`/`b3`,
  qui vivent dans `scripts.<hash>.js` (obfusque, s'appuie sur `CryptoJS`).

## Auto-reparation

`kkey.ts` fonctionne avec les constantes ci-dessus par defaut, mais :

- la **fonction** est retelechargee depuis `common.js` (8 Ko) et mise en cache 12 h ;
- une **salve de 403** declenche une re-decouverte complete (scripts de la page
  d'accueil, table des chunks, re-extraction des constantes par `indexOf` litteral) ;
- `config/kisskh-kkey.json` permet a l'operateur de **forcer** n'importe laquelle de
  ces valeurs a chaud, sans redeploiement, si l'automatisme echoue.

## Regle de securite non negociable

Le bundle `main.js` fait 1,2 Mo **sur une seule ligne**. Une regex a quantificateurs
bornes dessus a deja consomme **8 Go** sur un fichier comparable. Toute recherche dans
ces fichiers se fait par `indexOf` litteral + `slice`. Jamais autrement.
