// Dechiffrement des pistes de sous-titres KissKH.
//
// Toutes les pistes ne sont pas en clair. Le lecteur du site (chunk 876) revele :
//
//   var ext = src.split('.').pop();
//   onload = ext !== 'srt'
//     ? (ext === 'txt' ? b1(cue.text) : ext === 'txt1' ? b2(cue.text) : b3(cue.text))
//     : rienAFaire;
//
// Point important : c'est le TEXTE DE CHAQUE SOUS-TITRE qui est chiffre, pas le
// fichier. La structure (horodatages, numerotation) reste lisible ; seules les
// repliques sont brouillees.
//
// Et `cryptoService` delegue a trois globaux : b1 = a1(texte, e), b2 = a2(...),
// b3 = a3(...) — ou `e` est le module webpack 7206, qui n'est autre que **CryptoJS**
// (il agrege core, aes, enc-base64, md5...). On fournit donc le paquet npm crypto-js
// comme second argument, et on execute leurs fonctions plutot que de deviner leur
// algorithme.
//
// Meme parti pris que pour le kkey : on emprunte leur code au lieu de le reimplementer.
//
// ETAT DE VERIFICATION — a lire avant de faire confiance a ce fichier : sur douze
// dramas coreens recents sondes le 2026-08-12, TOUTES les pistes etaient en `.srt`,
// donc en clair. Ce chemin n'a donc PAS pu etre valide sur un cas reel. Il est ecrit
// defensivement : il ne se declenche que sur une extension non-`srt`, et si le
// resultat ne ressemble pas a du texte lisible, on renonce et on ne sert rien plutot
// que d'afficher du charabia par-dessus la video.

import * as vm from 'node:vm';
import * as CryptoJS from 'crypto-js';
import { getText } from '../../../core/http';
import { constants } from './kkey';

type DecryptFn = (texte: string, crypto: unknown) => string;

interface Decrypteurs {
  a1?: DecryptFn;
  a2?: DecryptFn;
  a3?: DecryptFn;
}

const TTL_MS = 12 * 60 * 60 * 1000;
let cache: Decrypteurs | null = null;
let cachedAt = 0;
let chargement: Promise<Decrypteurs> | null = null;

/** Les `src=` de la page d'accueil, par balayage litteral (jamais de regex ici). */
function scriptSources(html: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = html.indexOf('src=', i)) !== -1) {
    const quote = html[i + 4];
    if (quote !== '"' && quote !== "'") {
      i += 4;
      continue;
    }
    const end = html.indexOf(quote, i + 5);
    if (end === -1) break;
    out.push(html.slice(i + 5, end));
    i = end + 1;
  }
  return out;
}

function absolute(base: string, src: string): string {
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  if (src.startsWith('//')) return `https:${src}`;
  return `${base}/${src.replace(/^\.?\//, '')}`;
}

/**
 * Charge les trois fonctions.
 *
 * Elles sont reparties sur DEUX fichiers — `a1` dans `scripts.js?v=2`, `a2` et `a3`
 * dans `scripts.<hash>.js` — d'ou le balayage de tous les scripts « legers » plutot
 * qu'un chemin en dur.
 */
async function charger(): Promise<Decrypteurs> {
  const base = constants().base;
  const html = await getText(`${base}/`, { timeoutMs: 20000 });
  if (!html) return {};

  const scripts = scriptSources(html)
    .filter((s) => s.includes('scripts') && (s.endsWith('.js') || s.includes('.js?')))
    .map((s) => absolute(base, s));

  const trouve: Decrypteurs = {};
  for (const url of [...new Set(scripts)]) {
    const src = await getText(url, { timeoutMs: 20000, maxBytes: 512 * 1024 });
    if (!src) continue;

    const sandbox: Record<string, unknown> = {
      CryptoJS,
      console: { log: () => {}, error: () => {}, warn: () => {} },
      window: {},
      document: {},
    };
    const context = vm.createContext(sandbox);
    try {
      vm.runInContext(src, context, { timeout: 5000 });
    } catch {
      // Un script qui echoue au chargement peut avoir defini ce qu'on cherche avant.
    }

    for (const nom of ['a1', 'a2', 'a3'] as const) {
      const valeur = sandbox[nom];
      if (typeof valeur === 'function' && valeur.length === 2 && !trouve[nom]) {
        trouve[nom] = valeur as DecryptFn;
      }
    }
    if (trouve.a1 && trouve.a2 && trouve.a3) break;
  }

  const noms = Object.keys(trouve);
  console.log(
    noms.length > 0
      ? `[KissKH] dechiffreurs de sous-titres charges : ${noms.join(', ')}`
      : '[KissKH] aucun dechiffreur de sous-titres trouve',
  );
  return trouve;
}

async function decrypteurs(): Promise<Decrypteurs> {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  if (chargement) return chargement;

  chargement = charger()
    .then((d) => {
      cache = d;
      cachedAt = Date.now();
      return d;
    })
    .finally(() => {
      chargement = null;
    });
  return chargement;
}

/** Extension utile d'une URL de sous-titre : `.../fichier.txt1?x=1` -> `txt1`. */
export function extensionDe(url: string): string {
  const sansQuery = url.split(/[?#]/)[0];
  const point = sansQuery.lastIndexOf('.');
  return point === -1 ? '' : sansQuery.slice(point + 1).toLowerCase();
}

/** Une piste avec cette extension demande-t-elle un dechiffrement ? */
export function estChiffre(url: string): boolean {
  const ext = extensionDe(url);
  return ext !== '' && ext !== 'srt' && ext !== 'vtt' && ext !== 'ass' && ext !== 'ssa';
}

/**
 * Un texte dechiffre est-il credible ?
 *
 * Sans ce controle, une fonction inadaptee produirait des octets aleatoires qu'on
 * afficherait par-dessus la video. On exige donc une proportion raisonnable de
 * caracteres imprimables.
 */
export function semblePlausible(texte: string): boolean {
  if (!texte || texte.length < 2) return false;
  let imprimables = 0;
  for (const c of texte) {
    const code = c.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 0xfffd)) imprimables++;
  }
  return imprimables / texte.length > 0.9;
}

/**
 * Dechiffre les repliques d'un VTT. Rend null si l'operation n'aboutit pas — l'appelant
 * doit alors ne rien servir.
 *
 * On ne touche QUE les lignes de texte : la ligne `WEBVTT`, les horodatages
 * (`--> `) et les lignes vides restent telles quelles.
 */
export async function dechiffrerVtt(vtt: string, urlSource: string): Promise<string | null> {
  const ext = extensionDe(urlSource);
  const fns = await decrypteurs();
  const fn = ext === 'txt' ? fns.a1 : ext === 'txt1' ? fns.a2 : fns.a3;
  if (!fn) return null;

  const lignes = vtt.split('\n');
  const sortie: string[] = [];
  let dechiffrees = 0;
  let echecs = 0;

  for (const ligne of lignes) {
    const brute = ligne.trim();
    const estStructure =
      brute === '' ||
      brute === 'WEBVTT' ||
      brute.includes('-->') ||
      /^\d+$/.test(brute) ||
      brute.startsWith('NOTE ');

    if (estStructure) {
      sortie.push(ligne);
      continue;
    }

    try {
      const clair = fn(brute, CryptoJS);
      if (typeof clair === 'string' && semblePlausible(clair)) {
        sortie.push(clair);
        dechiffrees++;
      } else {
        echecs++;
        sortie.push(ligne);
      }
    } catch {
      echecs++;
      sortie.push(ligne);
    }
  }

  // Si l'essentiel a echoue, c'est que ce n'etait pas la bonne fonction (ou pas du
  // contenu chiffre). Mieux vaut renoncer que servir un melange incoherent.
  if (dechiffrees === 0 || echecs > dechiffrees) return null;
  return sortie.join('\n');
}
