import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenEntries, isRedirector } from './alldebrid';
import { pickFile, episodeHint, extractHash, toMagnet } from './types';

// Forme reelle renvoyee par /v4.1/magnet/status, relevee le 2026-08-13 : un ARBRE,
// avec des noms de champs abreges (n = nom, s = taille, l = lien, e = enfants).
const ARBRE = [
  {
    n: 'Squid Game (2021) S01 MULTi VFI x265-QTZ',
    e: [
      { n: 'Squid Game S01E01 x265-QTZ.mkv', s: 1705372223, l: 'https://ad/1' },
      { n: 'Squid Game S01E02 x265-QTZ.mkv', s: 1600000000, l: 'https://ad/2' },
      { n: 'Sample.mkv', s: 30000000, l: 'https://ad/sample' },
      { n: 'Squid Game S01E01.srt', s: 42000, l: 'https://ad/sub' },
    ],
  },
];

test('l arbre est aplati, enfants compris', () => {
  const plat = flattenEntries(ARBRE);
  // Le dossier lui-meme + ses quatre entrees.
  assert.equal(plat.length, 5);
  assert.ok(plat.some((e) => e.n === 'Squid Game S01E02 x265-QTZ.mkv'));
});

test('le dossier racine n a pas de lien : il ne doit pas etre jouable', () => {
  const plat = flattenEntries(ARBRE);
  const dossier = plat.find((e) => e.n?.startsWith('Squid Game (2021)'));
  assert.equal(dossier?.l, undefined);
});

test('un arbre absent ou malforme ne fait pas planter', () => {
  assert.deepEqual(flattenEntries(undefined), []);
  assert.deepEqual(flattenEntries([]), []);
  assert.deepEqual(flattenEntries([null as never, 'x' as never]), []);
});

test('le bon episode est choisi dans un pack', () => {
  const fichiers = flattenEntries(ARBRE)
    .filter((e) => e.l && e.n)
    .map((e) => ({ name: e.n as string, sizeBytes: e.s, link: e.l }));

  const choisi = pickFile(fichiers, episodeHint(1, 2));
  assert.equal(choisi?.name, 'Squid Game S01E02 x265-QTZ.mkv');
});

test('un echantillon n est jamais servi a la place du film', () => {
  const fichiers = [
    { name: 'Sample.mkv', sizeBytes: 30000000 },
    { name: 'Drama.S01E01.mkv', sizeBytes: 1500000000 },
  ];
  assert.equal(pickFile(fichiers)?.name, 'Drama.S01E01.mkv');
});

test('les sous-titres ne sont pas pris pour la video', () => {
  const fichiers = flattenEntries(ARBRE)
    .filter((e) => e.l && e.n)
    .map((e) => ({ name: e.n as string, sizeBytes: e.s, link: e.l }));
  assert.ok(!pickFile(fichiers, 's01e01')?.name.endsWith('.srt'));
});

test('les redirecteurs des sites FR sont reconnus', () => {
  // Sans ca, /link/unlock recoit une page intermediaire et echoue.
  assert.equal(isRedirector('https://dl-protect.link/abc'), true);
  assert.equal(isRedirector('https://zoneurs.net/?url=xyz'), true);
  assert.equal(isRedirector('https://1fichier.com/?abc'), false);
});

test('hash et magnet sont interchangeables', () => {
  const hash = 'c9a15e0da7f7c6b216c74a8df3c64c1724dca518';
  assert.equal(extractHash(hash), hash);
  assert.equal(extractHash(`magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=x`), hash);
  assert.equal(toMagnet(hash), `magnet:?xt=urn:btih:${hash}`);
  assert.equal(extractHash('pas un hash'), null);
});
