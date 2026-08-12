import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { toVtt, srtToVtt, assToVtt, detectFormat, decodeText, maybeGunzip } from './convert';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Bonjour

2
00:00:04,000 --> 00:00:06,000
Au revoir
`;

const ASS = `[Script Info]
Title: Test

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}Bonjour
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Ligne un\\NLigne deux
`;

test('SRT vers VTT : virgules converties en points', () => {
  const vtt = srtToVtt(SRT);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:03.500'));
  assert.ok(!vtt.includes(','), 'aucune virgule ne doit rester dans les horodatages');
  assert.ok(vtt.includes('Bonjour'));
});

test('ASS vers VTT : balises de style retirees, sauts de ligne convertis', () => {
  const vtt = assToVtt(ASS);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:03.500'));
  assert.ok(vtt.includes('Bonjour'));
  assert.ok(!vtt.includes('{\\an8}'), 'les balises ASS doivent disparaitre');
  assert.ok(vtt.includes('Ligne un\nLigne deux'), '\\N doit devenir un vrai saut de ligne');
});

test("ASS : l'ordre des colonnes est lu dans la ligne Format", () => {
  const reordered = `[Events]
Format: Start, End, Text
Dialogue: 0:00:02.00,0:00:05.00,Texte deplace
`;
  const vtt = assToVtt(reordered);
  assert.ok(vtt.includes('00:00:02.000 --> 00:00:05.000'));
  assert.ok(vtt.includes('Texte deplace'));
});

test('detection du format par le contenu, pas par l extension', () => {
  assert.equal(detectFormat(SRT), 'srt');
  assert.equal(detectFormat(ASS), 'ass');
  assert.equal(detectFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nX'), 'vtt');
  assert.equal(detectFormat('nawak binaire '), 'inconnu');
});

test('toVtt rend null sur un contenu illisible (piste chiffree KissKH)', () => {
  assert.equal(toVtt(Buffer.from('U2FsdGVkX1+chiffre+illisible', 'utf-8')), null);
});

test('toVtt decompresse le gzip (OpenSubtitles legacy)', () => {
  const gz = zlib.gzipSync(Buffer.from(SRT, 'utf-8'));
  const vtt = toVtt(gz);
  assert.ok(vtt?.startsWith('WEBVTT'));
  assert.ok(vtt?.includes('Bonjour'));
});

test('maybeGunzip laisse passer un contenu non compresse', () => {
  const plain = Buffer.from('WEBVTT', 'utf-8');
  assert.equal(maybeGunzip(plain).toString(), 'WEBVTT');
});

test('decodeText retire le BOM', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('WEBVTT', 'utf-8')]);
  assert.equal(decodeText(withBom), 'WEBVTT');
});

test('decodeText retombe sur latin1 quand l UTF-8 casse', () => {
  // "Précédemment" en latin1 : invalide en UTF-8.
  const latin1 = Buffer.from('Pr\xe9c\xe9demment dans la s\xe9rie', 'latin1');
  assert.ok(decodeText(latin1).includes('Précédemment'));
});
