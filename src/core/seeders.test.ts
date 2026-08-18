// Un torrent qu'il faut encore telecharger a besoin de pairs.
//
// A zero seeder, le debrideur ne trouvera personne : l'entree s'affiche comme jouable,
// on la choisit, et il ne se passe rien. Vecu sur « 1 Litre of Tears » — une release
// Nyaa a 0 seeder proposee au meme rang que les autres.

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
};

const torrent = (seeders?: number) =>
  ({ sourceId: 'nyaa', kind: 'torrent', title: 'un pack', quality: '720p', seeders }) as never;

test('un torrent a debrider sans pairs est ecarte', () => {
  assert.equal(passeFiltres({ candidate: torrent(0), cached: false }, BASE), false);
  assert.equal(passeFiltres({ candidate: torrent(4), cached: false }, BASE), false);
});

test('au seuil, il passe', () => {
  assert.equal(passeFiltres({ candidate: torrent(5), cached: false }, BASE), true);
});

test('deja en cache, les pairs n ont plus d importance', () => {
  // Le debrideur a le fichier : il n'a besoin de personne pour le servir.
  assert.equal(passeFiltres({ candidate: torrent(0), cached: true }, BASE), true);
});

test('un nombre inconnu ne fait rien disparaitre', () => {
  // Plusieurs sources n'annoncent pas leurs seeders. Couper sur l'ignorance
  // supprimerait des flux parfaitement valables — c'est la regle de tout ce fichier.
  assert.equal(passeFiltres({ candidate: torrent(undefined), cached: false }, BASE), true);
});
