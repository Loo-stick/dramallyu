// Ce fichier couvre le format EN CLAIR : compatibilite ascendante et instances sans
// secret. On retire explicitement TOKEN_SECRET pour ne pas dependre de
// l'environnement — le format chiffre a ses propres tests dans crypto.test.ts.
delete process.env.TOKEN_SECRET;

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

test('maxResults est borne, et 0 signifie illimite', () => {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(parseConfig(b64({ maxResults: -5 })).maxResults, 0);
  assert.equal(parseConfig(b64({ maxResults: 0 })).maxResults, 0);
  assert.equal(parseConfig(b64({ maxResults: 9999 })).maxResults, 200);
});

test('les filtres avances sont neutres par defaut', () => {
  // Quelqu'un qui installe sans rien regler doit voir l'offre entiere.
  const cfg = parseConfig('');
  assert.equal(cfg.cachedOnly, false);
  assert.equal(cfg.priorite, 'aucune');
  assert.equal(cfg.maxSizeGb, 0);
  assert.equal(cfg.minResolution, '');
  assert.deepEqual(cfg.excludeFormats, []);
  assert.equal(cfg.excludeCam, false);
});

test('les filtres avances font l aller-retour', () => {
  const segment = encodeConfig({
    cachedOnly: true,
    priorite: 'direct',
    minResolution: '720p',
    maxSizeGb: 15,
    excludeFormats: ['HEVC', 'DTS'],
    excludeCam: true,
    bonusHdr: true,
    sortBy: 'size',
  });
  const cfg = parseConfig(segment);
  assert.equal(cfg.cachedOnly, true);
  assert.equal(cfg.priorite, 'direct');
  assert.equal(cfg.minResolution, '720p');
  assert.equal(cfg.maxSizeGb, 15);
  assert.deepEqual(cfg.excludeFormats, ['HEVC', 'DTS']);
  assert.equal(cfg.excludeCam, true);
  assert.equal(cfg.bonusHdr, true);
  assert.equal(cfg.sortBy, 'size');
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

test('TOUS les champs de UserConfig survivent a l aller-retour', () => {
  // Garde-fou contre une regression vecue : les filtres avances etaient lus par
  // parseConfig mais absents de la liste blanche de l'encodeur, donc perdus a la
  // generation du lien. Le reglage semblait accepte, puis restait sans effet.
  const complet = {
    ad: 'A', tb: 'B', c411: 'C', tr4ker: 'D', tmdb: 'E',
    subLangs: ['kor'], excludeQualities: ['360p'], sources: ['kisskh'],
    sortBy: 'size' as const, maxResults: 12,
    cachedOnly: true, priorite: 'torrent' as const,
    minResolution: '480p', maxResolution: '1080p', minSource: 'WEBRip',
    maxSizeGb: 9, excludeFormats: ['DTS'], excludeCam: true, bonusHdr: true,
  };
  const relu = parseConfig(encodeConfig(complet));
  for (const [cle, attendu] of Object.entries(complet)) {
    assert.deepEqual(
      (relu as Record<string, unknown>)[cle],
      attendu,
      `le champ « ${cle} » ne survit pas a l aller-retour`,
    );
  }
});
