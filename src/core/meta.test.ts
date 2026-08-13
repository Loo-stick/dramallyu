import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estAsiatique, countryToLanguage } from './meta';
import type { WorkInfo } from './meta';

const oeuvre = (over: Partial<WorkInfo> = {}): WorkInfo => ({
  type: 'series', titles: ['X'], ...over,
});

test('les pays du creneau passent', () => {
  for (const pays of ['South Korea', 'Japan', 'China', 'Thailand', 'Taiwan', 'Hong Kong']) {
    assert.equal(estAsiatique(oeuvre({ country: pays })), true, pays);
  }
});

test('le hors-creneau est ecarte', () => {
  // Mesure qui a motive ce garde-fou : sans lui, l'addon rendait 10 flux sur
  // Spider-Man et 8 sur Barbie, en deposant au passage des magnets sur le compte
  // AllDebrid de l'utilisateur.
  for (const pays of ['United States', 'United States, United Kingdom', 'France', 'Spain']) {
    assert.equal(estAsiatique(oeuvre({ country: pays })), false, pays);
  }
});

test('la langue d origine prime sur le pays', () => {
  // Une coproduction americaine tournee en coreen releve bien du creneau.
  assert.equal(estAsiatique(oeuvre({ country: 'United States', originalLanguage: 'ko' })), true);
  assert.equal(estAsiatique(oeuvre({ country: 'Japan', originalLanguage: 'en' })), false);
});

test('un id de notre catalogue est asiatique par construction', () => {
  assert.equal(estAsiatique(oeuvre({ kkhId: '3749' })), true);
});

test('en cas de doute, on repond OUI', () => {
  // Perdre un drama parce qu'une metadonnee manquait serait pire qu'une recherche
  // inutile. C'est la regle du projet : ne pas couper sur ce qu'on ne sait pas.
  assert.equal(estAsiatique(oeuvre()), true);
  assert.equal(estAsiatique(oeuvre({ country: '' })), true);
});

test('la conversion pays -> langue reste coherente', () => {
  assert.equal(countryToLanguage('South Korea'), 'ko');
  assert.equal(countryToLanguage('Japan'), 'ja');
  assert.equal(countryToLanguage(undefined), undefined);
});
