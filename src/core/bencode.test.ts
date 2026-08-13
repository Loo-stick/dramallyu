import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { infoHashDepuisTorrent } from './bencode';

/** Chaine bencodee. La longueur est CALCULEE : la compter a la main se paie cher. */
const b = (s: string): string => `${s.length}:${s}`;

/** Assemble un .torrent minimal autour d'un dictionnaire `info` donne. */
function torrent(info: string, avant = '', apres = ''): Buffer {
  return Buffer.from(`d${avant}4:info${info}${apres}e`, 'latin1');
}

const sha1 = (s: string): string => createHash('sha1').update(Buffer.from(s, 'latin1')).digest('hex');

test('le hash porte sur les octets EXACTS du dictionnaire info', () => {
  const info = `d${b('length')}i1024e${b('name')}${b('film.mkv')}e`;
  assert.equal(infoHashDepuisTorrent(torrent(info)), sha1(info));
});

test('les cles qui precedent info sont traversees sans se perdre', () => {
  const info = `d${b('length')}i42e${b('name')}${b('a.mkv')}e`;
  const avant = `${b('announce')}${b('http://tracker/announce')}${b('creation date')}i1700000000e`;
  assert.equal(infoHashDepuisTorrent(torrent(info, avant)), sha1(info));
});

test('un « 4:info » enfoui ailleurs ne detourne pas le hash', () => {
  // Piege reel : un nom de fichier ou une liste d'annonceurs peut contenir cette
  // suite d'octets. Chercher la chaine n'importe ou hacherait la mauvaise plage.
  const info = `d${b('name')}${b('vrai.mkv')}e`;
  const avant = `${b('comment')}${b('vu ici 4:infod')}`;
  assert.equal(infoHashDepuisTorrent(torrent(info, avant)), sha1(info));
});

test('les listes imbriquees sont delimitees correctement', () => {
  const info = `d${b('files')}ld${b('length')}i1eee${b('name')}${b('abc')}e`;
  const avant = `${b('announce-list')}ll${b('http://tracker/announce')}ee`;
  assert.equal(infoHashDepuisTorrent(torrent(info, avant)), sha1(info));
});

test('un contenu qui n est pas un torrent rend null', () => {
  assert.equal(infoHashDepuisTorrent(Buffer.from('<html>404</html>', 'latin1')), null);
  assert.equal(infoHashDepuisTorrent(Buffer.alloc(0)), null);
  // Dictionnaire valide mais sans cle info.
  assert.equal(infoHashDepuisTorrent(Buffer.from(`d${b('announce')}${b('x://y')}e`, 'latin1')), null);
});

test('un fichier tronque rend null plutot qu un hash faux', () => {
  const complet = torrent(`d${b('length')}i1024e${b('name')}${b('film.mkv')}e`);
  assert.equal(infoHashDepuisTorrent(complet.subarray(0, complet.length - 12)), null);
});
