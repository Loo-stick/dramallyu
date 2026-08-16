import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlCatalogue } from './tmdb-catalogue';

const base = { page: 1, cle: 'CLE', type: 'series' as const };

test('une rubrique pays cible le PAYS D ORIGINE, pas la langue', () => {
  // Le mandarin se parle a Taiwan comme en Chine continentale : une rubrique
  // « Taiwan » filtree sur la langue rendrait Pekin.
  const u = new URL(urlCatalogue({ ...base, pays: 'TW' }));
  assert.equal(u.searchParams.get('with_origin_country'), 'TW');
  assert.equal(u.searchParams.get('with_original_language'), null);
});

test('une rubrique globale filtre sur les langues du creneau', () => {
  const u = new URL(urlCatalogue({ ...base }));
  assert.equal(u.searchParams.get('with_original_language'), 'ko|zh|ja|th');
});

test('les nouveautes sont bornees dans le temps et en votes', () => {
  // Sans borne haute, TMDB remonte des fiches annoncees pour dans deux ans ; sans
  // plancher de votes, des fiches vides creees la veille.
  const u = new URL(urlCatalogue({ ...base, tri: 'nouveautes' }));
  assert.equal(u.searchParams.get('sort_by'), 'first_air_date.desc');
  assert.match(u.searchParams.get('first_air_date.lte') ?? '', /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(u.searchParams.get('vote_count.gte'), '5');
});

test('un film utilise les champs de date du film', () => {
  const u = new URL(urlCatalogue({ ...base, type: 'movie', tri: 'nouveautes' }));
  assert.ok(u.pathname.includes('/discover/movie'));
  assert.equal(u.searchParams.get('sort_by'), 'release_date.desc');
  assert.ok(u.searchParams.has('release_date.lte'));
});

test('une recherche part sur /search et ignore les filtres', () => {
  const u = new URL(urlCatalogue({ ...base, pays: 'KR', recherche: 'Squid Game' }));
  assert.ok(u.pathname.includes('/search/tv'));
  assert.equal(u.searchParams.get('query'), 'Squid Game');
  assert.equal(u.searchParams.get('with_origin_country'), null);
});

test('la cle est transmise, et la page aussi', () => {
  const u = new URL(urlCatalogue({ ...base, page: 3 }));
  assert.equal(u.searchParams.get('api_key'), 'CLE');
  assert.equal(u.searchParams.get('page'), '3');
  assert.equal(u.searchParams.get('language'), 'fr-FR');
});
