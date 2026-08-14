import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentDeConfig } from './admin';

const SEGMENT = 'e1.qibnnPecZdKrVgAz7nfwiI1X82DzqgjURoscEG';

test('extrait le segment d un lien de manifeste complet', () => {
  assert.equal(segmentDeConfig(`https://dramallyu.loostick.ovh/${SEGMENT}/manifest.json`), SEGMENT);
});

test('accepte le lien stremio:// et nuvio://', () => {
  assert.equal(segmentDeConfig(`stremio://dramallyu.loostick.ovh/${SEGMENT}/manifest.json`), SEGMENT);
  assert.equal(segmentDeConfig(`nuvio://dramallyu.loostick.ovh/${SEGMENT}/manifest.json`), SEGMENT);
});

test('accepte le segment seul, avec ou sans espaces', () => {
  assert.equal(segmentDeConfig(SEGMENT), SEGMENT);
  assert.equal(segmentDeConfig(`  ${SEGMENT}  `), SEGMENT);
});

test('accepte une adresse locale', () => {
  assert.equal(segmentDeConfig(`http://127.0.0.1:7020/${SEGMENT}/stream/series/tt1.json`), SEGMENT);
});

test('une entree vide reste vide', () => {
  assert.equal(segmentDeConfig(''), '');
  assert.equal(segmentDeConfig('   '), '');
});

test('rend l entree telle quelle quand rien ne ressemble a un segment', () => {
  // Mieux vaut laisser `parseConfig` refuser que deviner : une transformation
  // silencieuse rendrait l'echec incomprehensible.
  assert.equal(segmentDeConfig('nimporte quoi'), 'nimporte quoi');
});
