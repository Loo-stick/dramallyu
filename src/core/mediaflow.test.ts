import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throughMediaflow, passeParMediaflow, mediaflowConfig } from './mediaflow';
import type { UserConfig } from './config';

const AVEC = { mfpUrl: 'https://mfp.exemple.org', mfpPass: 'secret' } as UserConfig;
const URL_FILM = 'https://cdn.exemple.org/film.mp4';

test('sans MediaFlow declare, rien n est route', () => {
  assert.equal(mediaflowConfig({} as UserConfig), null);
  assert.equal(throughMediaflow(URL_FILM, 'ad', {} as UserConfig), URL_FILM);
});

test('une adresse sans mot de passe ne route pas', () => {
  // MediaFlow refuserait l'URL : mieux vaut un lien direct qu'un lien mort.
  const partiel = { mfpUrl: 'https://mfp.exemple.org' } as UserConfig;
  assert.equal(mediaflowConfig(partiel), null);
  assert.equal(throughMediaflow(URL_FILM, 'ad', partiel), URL_FILM);
});

test('declare mais rien de coche : rien ne passe', () => {
  // Le defaut est volontaire — router un flux qui n'en a pas besoin ajoute une
  // latence et une panne possible pour rien.
  const cfg = { ...AVEC, mfpPour: [] } as UserConfig;
  assert.equal(throughMediaflow(URL_FILM, 'ad', cfg), URL_FILM);
  assert.equal(passeParMediaflow(cfg, 'ad'), false);
});

test('chaque destination a son propre interrupteur', () => {
  const cfg = { ...AVEC, mfpPour: ['ad'] } as UserConfig;
  assert.ok(throughMediaflow(URL_FILM, 'ad', cfg).startsWith('https://mfp.exemple.org/proxy/stream'));
  // TorBox n'a pas ete coche : son lien part en direct.
  assert.equal(throughMediaflow(URL_FILM, 'tb', cfg), URL_FILM);
  assert.equal(throughMediaflow(URL_FILM, 'direct', cfg), URL_FILM);
});

test('un flux HLS passe par le point d entree manifeste', () => {
  const cfg = { ...AVEC, mfpPour: ['direct'] } as UserConfig;
  const r = throughMediaflow('https://cdn.exemple.org/live.m3u8', 'direct', cfg);
  assert.ok(r.includes('/proxy/hls/manifest.m3u8'));
});

test('les en-tetes sont retransmis en h_*', () => {
  const cfg = { ...AVEC, mfpPour: ['direct'] } as UserConfig;
  const r = throughMediaflow(URL_FILM, 'direct', cfg, { Referer: 'https://site.org/' });
  assert.ok(r.includes('h_referer=https%3A%2F%2Fsite.org%2F'));
});

test('l URL d origine est encodee, pas concatenee', () => {
  const cfg = { ...AVEC, mfpPour: ['ad'] } as UserConfig;
  const r = throughMediaflow('https://cdn.exemple.org/a b?x=1&y=2', 'ad', cfg);
  assert.ok(!r.includes(' '));
  assert.ok(r.includes('api_password=secret'));
  // Le & de l'URL d'origine ne doit pas couper la requete en deux parametres.
  assert.equal(new URL(r).searchParams.get('d'), 'https://cdn.exemple.org/a b?x=1&y=2');
});

test('une barre finale sur l adresse ne double pas', () => {
  const cfg = { mfpUrl: 'https://mfp.exemple.org/', mfpPass: 'secret', mfpPour: ['ad'] } as UserConfig;
  assert.ok(throughMediaflow(URL_FILM, 'ad', cfg).startsWith('https://mfp.exemple.org/proxy/'));
});
