// La version annoncee a Stremio doit etre celle du paquet.
//
// Elle a diverge pendant tout le cycle 1.0 : le manifeste annoncait `0.1.0` alors que
// le paquet etait en 1.1.0. Personne ne pouvait le voir depuis un client, et c'est
// pourtant le seul numero dont disposent Stremio et AIOStreams pour savoir ce qui
// tourne — donc le seul sur lequel s'appuie un rapport de bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ADDON_VERSION } from './manifest';

test('le manifeste annonce la version de package.json', () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'),
  ) as { version: string };
  assert.equal(ADDON_VERSION, pkg.version);
});

test('la version a la forme X.Y.Z', () => {
  // Stremio compare des versions : une valeur vide ou fantaisiste passerait le test
  // precedent en cas de lecture ratee du paquet.
  assert.match(ADDON_VERSION, /^\d+\.\d+\.\d+$/);
});
