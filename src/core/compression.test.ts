import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { compression } from './compression';

/** Reponse minimale, juste ce dont le middleware se sert. */
function fausseReponse(type: string) {
  const entetes: Record<string, string> = { 'Content-Type': type };
  let envoye: unknown;
  const res = {
    getHeader: (n: string) => entetes[n],
    setHeader: (n: string, v: string) => { entetes[n] = v; },
    send: (c: unknown) => { envoye = c; return res; },
  };
  return { res, entetes, lu: () => envoye };
}

function passer(accept: string, type: string, corps: string) {
  const f = fausseReponse(type);
  compression({ headers: { 'accept-encoding': accept } } as never, f.res as never, () => {});
  (f.res as { send: (c: unknown) => unknown }).send(corps);
  return f;
}

const LONG = 'WEBVTT\n\n' + '1\n00:00:12.095 --> 00:00:14.000\nBonjour tout le monde\n\n'.repeat(200);

test('un VTT volumineux est compresse en gzip', () => {
  const f = passer('gzip', 'text/vtt; charset=utf-8', LONG);
  assert.equal(f.entetes['Content-Encoding'], 'gzip');
  assert.equal(f.entetes['Vary'], 'Accept-Encoding');
  assert.equal(gunzipSync(f.lu() as Buffer).toString('utf-8'), LONG);
  // Le gain doit etre reel, sinon la compression ne se justifie pas.
  assert.ok((f.lu() as Buffer).length < Buffer.byteLength(LONG) / 4);
});

test('brotli est prefere quand le client l accepte', () => {
  const f = passer('gzip, br', 'text/vtt', LONG);
  assert.equal(f.entetes['Content-Encoding'], 'br');
  assert.equal(brotliDecompressSync(f.lu() as Buffer).toString('utf-8'), LONG);
});

test('une petite reponse passe telle quelle', () => {
  // En dessous du seuil, l en-tete gzip couterait plus qu il ne rapporte.
  const f = passer('gzip', 'application/json', '{"streams":[]}');
  assert.equal(f.entetes['Content-Encoding'], undefined);
  assert.equal(f.lu(), '{"streams":[]}');
});

test('un client qui ne sait pas decompresser reçoit du texte', () => {
  const f = passer('identity', 'text/vtt', LONG);
  assert.equal(f.entetes['Content-Encoding'], undefined);
  assert.equal(f.lu(), LONG);
});

test('un type non textuel n est pas touche', () => {
  const f = passer('gzip', 'video/mp4', LONG);
  assert.equal(f.entetes['Content-Encoding'], undefined);
});
