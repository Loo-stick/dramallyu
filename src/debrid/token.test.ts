// La cle doit etre posee AVANT le premier chiffrement (derivation paresseuse).
process.env.TOKEN_SECRET = 'secret-de-test-suffisamment-long-0123456789';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeToken, decodeToken } from './token';

test('aller-retour d un jeton de lecture', () => {
  const jeton = encodeToken({ k: 'torrent', v: 'a'.repeat(40), f: 's01e09', ad: 'CLE_AD', tb: 'CLE_TB' });
  const relu = decodeToken(jeton);
  assert.equal(relu?.v, 'a'.repeat(40));
  assert.equal(relu?.ad, 'CLE_AD');
  assert.equal(relu?.f, 's01e09');
});

test('AUCUNE cle n est lisible dans le jeton', () => {
  // Regression vecue : le jeton n'etait que signe, donc parfaitement lisible en
  // base64 — et ces URL sont remises au lecteur, donc exposees aux journaux et aux
  // captures d'ecran. Quiconque en voyait une recuperait les cles debrid.
  const jeton = encodeToken({ k: 'torrent', v: 'b'.repeat(40), ad: 'CLE_AD_SECRETE', tb: 'CLE_TB_SECRETE' });
  assert.ok(!jeton.includes('CLE_AD_SECRETE'));
  assert.ok(!jeton.includes('CLE_TB_SECRETE'));

  // Ni en clair, ni apres decodage base64 sous ses deux formes.
  for (const partie of jeton.split('.')) {
    for (const encodage of ['base64url', 'base64'] as const) {
      const decode = Buffer.from(partie, encodage).toString('latin1');
      assert.ok(!decode.includes('CLE_AD'), `cle lisible en ${encodage}`);
      assert.ok(!decode.includes('CLE_TB'), `cle lisible en ${encodage}`);
    }
  }
});

test('un jeton altere est refuse', () => {
  const jeton = encodeToken({ k: 'ddl', v: 'https://x/y', ad: 'CLE' });
  const corps = jeton.slice(3);
  const altere = `e1.${corps.slice(0, -2)}${corps.slice(-2, -1) === 'A' ? 'B' : 'A'}${corps.slice(-1)}`;
  assert.equal(decodeToken(altere), null);
});

test('un jeton illisible rend null plutot que de lever', () => {
  for (const mauvais of ['', 'nimportequoi', 'e1.abc', 'a.b']) {
    assert.equal(decodeToken(mauvais), null);
  }
});
