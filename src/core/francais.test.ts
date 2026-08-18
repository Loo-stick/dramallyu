// Ce qui vaut PREUVE de francais.
//
// Trois degres, du plus sur au moins sur : l'origine, les pistes reellement lues, puis
// l'etiquette du titre — qui n'est qu'une declaration de l'uploadeur.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { porteDuFrancais } from './filters';

const cand = (o: Record<string, unknown>) =>
  ({ kind: 'torrent', title: 'un pack', quality: '720p', ...o }) as never;

test('un tracker francophone suffit, meme sans marqueur dans le titre', () => {
  // C'est le cas que l'etiquette rate : on n'y publie pas sans francais, mais le nom
  // de la release ne le dit pas toujours.
  for (const src of ['c411', 'tr4ker', 'yggreborn', 'g3mini']) {
    assert.equal(porteDuFrancais(cand({ sourceId: src, language: '' })), true, src);
  }
});

test('les trackers internationaux ne beneficient pas de leur origine', () => {
  // DigitalCore et DarkPeers hebergent du monde entier : l'absence de marqueur n'y dit
  // rien, et leur accorder le francais d'office servirait des flux illisibles.
  for (const src of ['dcore', 'dpeers', 'nyaa']) {
    assert.equal(porteDuFrancais(cand({ sourceId: src, language: '' })), false, src);
  }
});

test('une piste reellement lue prime sur tout', () => {
  assert.equal(
    porteDuFrancais(cand({ sourceId: 'nyaa', subs: [{ lang: 'fre', url: 'x', label: 'FR' }] })),
    true,
  );
});

test('le MediaInfo publie tranche dans les deux sens', () => {
  assert.equal(porteDuFrancais(cand({ sourceId: 'dpeers', languesIntegrees: ['fre'] })), true);
  assert.equal(
    porteDuFrancais(cand({ sourceId: 'dpeers', language: 'MULTI', languesIntegrees: ['eng'] })),
    false,
    'un MULTI menteur doit tomber quand le MediaInfo le contredit',
  );
});

test('faute de mieux, l etiquette du titre', () => {
  assert.equal(porteDuFrancais(cand({ sourceId: 'nyaa', language: 'VOSTFR' })), true);
  assert.equal(porteDuFrancais(cand({ sourceId: 'nyaa', language: 'VO' })), false);
});
