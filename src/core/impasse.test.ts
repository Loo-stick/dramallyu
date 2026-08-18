// Une entree qui ne peut PAS aboutir ne doit pas etre proposee.
//
// Sur un tracker prive, l'annonceur n'existe que dans le fichier `.torrent`. Quand
// l'utilisateur refuse de l'envoyer — il contient sa passkey —, le debrideur ne recoit
// qu'un hash nu : aucun pair, aucun telechargement. Le ratio n'est pas entame (le
// tracker ne voit rien passer), mais la lecture ne demarrera jamais.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { passeFiltres, type Filtres } from './filters';

const BASE: Filtres = {
  minResolution: '',
  maxResolution: '',
  minSource: '',
  maxSizeGb: 0,
  excludeFormats: [],
  excludeCam: false,
  cachedOnly: false,
  verificationFaite: true,
  envoyerTorrent: false,
};

const t = (sourceId: string) =>
  ({ sourceId, kind: 'torrent', title: 'un pack', quality: '1080p', seeders: 40 }) as never;

test('prive + pas en cache + envoi refuse = ecarte', () => {
  for (const src of ['c411', 'tr4ker', 'yggreborn', 'g3mini', 'dpeers', 'dcore']) {
    assert.equal(passeFiltres({ candidate: t(src), cached: false }, BASE), false, src);
  }
});

test('deja en cache, il n a besoin d aucun pair', () => {
  assert.equal(passeFiltres({ candidate: t('c411'), cached: true }, BASE), true);
});

test('un tracker public n a pas besoin du .torrent', () => {
  // Nyaa est public : le hash nu suffit a trouver des pairs.
  assert.equal(passeFiltres({ candidate: t('nyaa'), cached: false }, BASE), true);
});

test('envoi autorise : l entree redevient jouable', () => {
  const ok = { ...BASE, envoyerTorrent: true };
  assert.equal(passeFiltres({ candidate: t('c411'), cached: false }, ok), true);
});

test('sans verification, on ne fait rien disparaitre', () => {
  // `cached` vaut `undefined` pour tout le monde tant que la verification n'a pas eu
  // lieu : appliquer la regle la ferait tomber sur l'ensemble des trackers prives.
  const froid = { ...BASE, verificationFaite: false };
  assert.equal(passeFiltres({ candidate: t('c411') }, froid), true);
});
