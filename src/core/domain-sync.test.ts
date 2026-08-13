import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metaContent, extraireDomaine } from './domain-sync';

// Extraits reels des apercus publics Telegram, releves le 2026-08-13.
const TG_WAWACITY = `<html><head>
<meta property="og:title" content="Wawacity.estate">
<meta property="og:description" content="Communauté officielle Wawacity ✅">
</head></html>`;

const TG_ZT = `<html><head>
<meta property="og:title" content="Zone Telechargement officielle">
<meta property="og:description" content="Communauté officielle de https://zone-telechargement.org/ ✅">
</head></html>`;

test('lit une metadonnee Open Graph', () => {
  assert.equal(metaContent(TG_WAWACITY, 'og:title'), 'Wawacity.estate');
  assert.equal(
    metaContent(TG_ZT, 'og:description'),
    'Communauté officielle de https://zone-telechargement.org/ ✅',
  );
});

test('metadonnee absente -> null, pas une exception', () => {
  assert.equal(metaContent('<html></html>', 'og:title'), null);
  assert.equal(metaContent('<meta property="og:title">', 'og:title'), null);
});

test('extrait le domaine Wawacity depuis le titre du canal', () => {
  assert.equal(extraireDomaine('Wawacity.estate', 'wawacity'), 'https://wawacity.estate');
});

test('extrait le domaine Zone-Telechargement depuis la description', () => {
  assert.equal(
    extraireDomaine('Communauté officielle de https://zone-telechargement.org/ ✅', 'zone-telechargement'),
    'https://zone-telechargement.org',
  );
});

test('le fragment protege contre un domaine tiers', () => {
  // Un canal qui mentionne d'autres sites ne doit pas faire basculer le notre.
  const texte = 'Rejoignez aussi https://autre-site.com et https://wawacity.estate';
  assert.equal(extraireDomaine(texte, 'wawacity'), 'https://wawacity.estate');
  assert.equal(extraireDomaine('Rien que https://autre-site.com', 'wawacity'), null);
});

test('le www et la ponctuation finale sont retires', () => {
  assert.equal(extraireDomaine('www.wawacity.estate.', 'wawacity'), 'https://wawacity.estate');
  assert.equal(extraireDomaine('(https://wawacity.estate)', 'wawacity'), 'https://wawacity.estate');
});

test('un texte sans domaine rend null', () => {
  assert.equal(extraireDomaine('aucune adresse ici', 'wawacity'), null);
  assert.equal(extraireDomaine('', 'wawacity'), null);
});
