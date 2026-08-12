import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStremioId, formatStremioId, workKey } from './ids';

test('id IMDb de film', () => {
  assert.deepEqual(parseStremioId('tt1399964'), {
    kind: 'imdb',
    value: 'tt1399964',
    season: undefined,
    episode: undefined,
  });
});

test('id IMDb de serie avec saison et episode', () => {
  const p = parseStremioId('tt1399964:2:5');
  assert.equal(p?.kind, 'imdb');
  assert.equal(p?.season, 2);
  assert.equal(p?.episode, 5);
});

test('id kkh — le prefixe compte comme un segment', () => {
  const p = parseStremioId('kkh:3749:1:3');
  assert.equal(p?.kind, 'kkh');
  assert.equal(p?.value, '3749');
  assert.equal(p?.season, 1);
  assert.equal(p?.episode, 3);
});

test('id tmdb', () => {
  const p = parseStremioId('tmdb:1396');
  assert.equal(p?.kind, 'tmdb');
  assert.equal(p?.value, '1396');
  assert.equal(p?.season, undefined);
});

test('ids inexploitables -> null, jamais une exception', () => {
  for (const bad of ['', 'nimporte', 'tt', 'kkh:', 'kkh:abc', 'tmdb:', ':::', 'anilist:42']) {
    assert.equal(parseStremioId(bad), null, `attendu null pour "${bad}"`);
  }
});

test('saison/episode absurdes ignores plutot que fatals', () => {
  const p = parseStremioId('tt1399964:0:abc');
  assert.equal(p?.season, undefined);
  assert.equal(p?.episode, undefined);
});

test('aller-retour parse/format', () => {
  for (const id of ['tt1399964', 'tt1399964:2:5', 'kkh:3749:1:3', 'tmdb:1396']) {
    const p = parseStremioId(id);
    assert.ok(p);
    assert.equal(formatStremioId(p), id);
  }
});

test('workKey ignore saison et episode', () => {
  assert.equal(workKey(parseStremioId('tt1399964:2:5')!), 'imdb:tt1399964');
  assert.equal(workKey(parseStremioId('kkh:3749:1:3')!), 'kkh:3749');
});
