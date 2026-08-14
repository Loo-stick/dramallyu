import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masquer } from './masque';

test('masque une passkey d indexeur', () => {
  const avant = '[HTTP] api.yggreborn.org/api?t=search&passkey=a1b2c3d4e5f6&q=squid';
  const apres = masquer(avant);
  assert.ok(!apres.includes('a1b2c3d4e5f6'));
  assert.ok(apres.includes('passkey=***'));
  // Le reste de la ligne doit survivre : sans elle, la trace ne sert a rien.
  assert.ok(apres.includes('q=squid') && apres.includes('yggreborn'));
});

test('masque les noms de parametres usuels, quelle que soit la casse', () => {
  for (const nom of ['apikey', 'API_KEY', 'ApiKey', 'token', 'agent', 'key', 'secret']) {
    const r = masquer(`https://exemple.org/api?${nom}=ZZZsecretZZZ&x=1`);
    assert.ok(!r.includes('ZZZsecretZZZ'), nom);
    assert.ok(r.includes('x=1'), nom);
  }
});

test('masque un en-tete Bearer', () => {
  assert.equal(
    masquer('Authorization: Bearer eyJhbGciOi.J9tRuC.qUeSeCrEt'),
    'Authorization: Bearer ***',
  );
});

test('masque une configuration chiffree', () => {
  const r = masquer('[Stream] GET /e1.qibnnPecZdKrVgAz7nfwiI1X82DzqgjURoscE/stream/series/tt1.json');
  assert.ok(r.includes('e1.***'));
  assert.ok(r.includes('/stream/series/tt1.json'));
});

test('NE masque PAS une empreinte de torrent', () => {
  // Quarante caracteres hexadecimaux, la meme forme que certaines cles : c'est
  // precisement ce qu'il ne faut pas confondre. Sans elle, plus aucun diagnostic de
  // torrent n'est possible.
  const hash = '2b7f1a9c4d5e6f708192a3b4c5d6e7f809112233';
  assert.equal(masquer(`[Debrid] envoi du torrent ${hash}`), `[Debrid] envoi du torrent ${hash}`);
});

test('laisse intacte une ligne ordinaire', () => {
  const l = '[KissKH] 12 candidats en 340 ms';
  assert.equal(masquer(l), l);
});

test('est idempotent', () => {
  const une = masquer('u=x?apikey=SECRET&h=1');
  assert.equal(masquer(une), une);
});

test('masque plusieurs secrets sur la meme ligne', () => {
  const r = masquer('?apikey=AAAA&passkey=BBBB&q=ok');
  assert.ok(!r.includes('AAAA') && !r.includes('BBBB'));
  assert.ok(r.includes('q=ok'));
});
