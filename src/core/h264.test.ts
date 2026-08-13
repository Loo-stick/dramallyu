import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dimensionsDepuisSps, qualiteDepuis } from './h264';

// SPS reel, capture sur un segment KissKH (« Sex Plate 17 », profil High 4.2).
// L'echantillon rend le test hors-ligne : le CDN change ses URL, pas ses dimensions.
const SPS_KISSKH = Buffer.from('64001facc86014016ec044000003000400000300f03c60c668', 'hex');

test('les dimensions se lisent dans le SPS H.264', () => {
  // KissKH ne publie NI master playlist NI champ de resolution dans son API : le flux
  // lui-meme est la seule source de verite. Verifie contre le flux reel avant d'etre
  // fige ici.
  assert.deepEqual(dimensionsDepuisSps(SPS_KISSKH), { width: 1280, height: 720 });
});

test('un SPS illisible rend null, jamais une valeur inventee', () => {
  assert.equal(dimensionsDepuisSps(Buffer.from('00', 'hex')), null);
  assert.equal(dimensionsDepuisSps(Buffer.alloc(0)), null);
  assert.equal(dimensionsDepuisSps(Buffer.from('ffffffffffffffff', 'hex')), null);
});

test('le format large ne fait pas declasser un flux', () => {
  // Mesure sur KissKH : « Doctor Climax » et « Squid Game » sortent en 1280x640, image
  // rognee plutot que barree de noir. Classer sur la hauteur seule en ferait du 576p.
  assert.equal(qualiteDepuis({ width: 1280, height: 640 }), '720p');
  assert.equal(qualiteDepuis({ width: 1920, height: 800 }), '1080p');
  assert.equal(qualiteDepuis({ width: 3840, height: 1600 }), '4K');
});

test('les formats classiques restent classes comme on les nomme', () => {
  assert.equal(qualiteDepuis({ width: 1280, height: 720 }), '720p');
  assert.equal(qualiteDepuis({ width: 1920, height: 1080 }), '1080p');
  assert.equal(qualiteDepuis({ width: 640, height: 480 }), '480p');
  // Un 4/3 ne doit pas etre promu par sa largeur.
  assert.equal(qualiteDepuis({ width: 720, height: 576 }), '576p');
});
