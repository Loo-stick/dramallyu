import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfig,
  encodeConfig,
  normalizeLangCode,
  sourceEnabledForUser,
  hasDebrid,
  DEFAULT_CONFIG,
} from './config';

test('aller-retour encode/parse', () => {
  const encoded = encodeConfig({ ad: 'CLE_AD', subLangs: ['fre'], sortBy: 'quality' });
  const cfg = parseConfig(encoded);
  assert.equal(cfg.ad, 'CLE_AD');
  assert.deepEqual(cfg.subLangs, ['fre']);
  assert.equal(cfg.sortBy, 'quality');
});

test('encode produit du base64url (ni + ni / ni =)', () => {
  // On force des octets qui produisent "+" et "/" en base64 standard.
  const encoded = encodeConfig({ ad: '~~~???>>>øøø', tb: 'ÿÿÿ<<<' });
  assert.ok(!/[+/=]/.test(encoded), `attendu base64url, obtenu: ${encoded}`);
  assert.equal(parseConfig(encoded).ad, '~~~???>>>øøø');
});

test('accepte aussi du base64 standard (liens colles a la main)', () => {
  const standard = Buffer.from(JSON.stringify({ tb: 'CLE_TB' }), 'utf-8').toString('base64');
  assert.equal(parseConfig(standard).tb, 'CLE_TB');
});

test('config absente ou illisible -> defauts, jamais une exception', () => {
  for (const bad of [undefined, null, '', 'pas-du-base64!!', 'eyJicm9rZW4i', '[]', 'bnVsbA']) {
    const cfg = parseConfig(bad as string | null | undefined);
    assert.deepEqual(cfg.subLangs, DEFAULT_CONFIG.subLangs);
    assert.equal(cfg.sortBy, 'language');
    assert.equal(cfg.ad, undefined);
  }
});

test('les champs inconnus sont ignores sans casser les connus', () => {
  const encoded = encodeConfig({ ad: 'X' } as never);
  const withJunk = Buffer.from(
    JSON.stringify({ ad: 'X', jesuisInconnu: 42, sortBy: 'nimporte' }),
    'utf-8',
  ).toString('base64url');
  assert.equal(parseConfig(withJunk).ad, 'X');
  assert.equal(parseConfig(withJunk).sortBy, 'language');
  assert.equal(parseConfig(encoded).ad, 'X');
});

test('les cles vides ne sont pas retenues', () => {
  const raw = Buffer.from(JSON.stringify({ ad: '   ', tb: '' }), 'utf-8').toString('base64url');
  const cfg = parseConfig(raw);
  assert.equal(cfg.ad, undefined);
  assert.equal(cfg.tb, undefined);
  assert.equal(hasDebrid(cfg), false);
});

test('maxResults est borne', () => {
  const low = parseConfig(Buffer.from(JSON.stringify({ maxResults: -5 })).toString('base64url'));
  const high = parseConfig(Buffer.from(JSON.stringify({ maxResults: 9999 })).toString('base64url'));
  assert.equal(low.maxResults, 1);
  assert.equal(high.maxResults, 200);
});

test('les codes langue a 2 lettres sont convertis en ISO 639-2', () => {
  assert.equal(normalizeLangCode('fr'), 'fre');
  assert.equal(normalizeLangCode('EN'), 'eng');
  assert.equal(normalizeLangCode('fre'), 'fre');
  const cfg = parseConfig(
    Buffer.from(JSON.stringify({ subLangs: ['fr', 'ko'] })).toString('base64url'),
  );
  assert.deepEqual(cfg.subLangs, ['fre', 'kor']);
});

test('liste de sources vide = toutes autorisees', () => {
  const cfg = parseConfig('');
  assert.equal(sourceEnabledForUser(cfg, 'kisskh'), true);
  const restreint = parseConfig(encodeConfig({ sources: ['kisskh'] }));
  assert.equal(sourceEnabledForUser(restreint, 'kisskh'), true);
  assert.equal(sourceEnabledForUser(restreint, 'nyaa'), false);
});

test('hasDebrid detecte une cle presente', () => {
  assert.equal(hasDebrid(parseConfig(encodeConfig({ ad: 'k' }))), true);
  assert.equal(hasDebrid(parseConfig(encodeConfig({ tb: 'k' }))), true);
  assert.equal(hasDebrid(parseConfig('')), false);
});
