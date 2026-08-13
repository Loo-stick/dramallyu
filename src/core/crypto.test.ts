import { test } from 'node:test';
import assert from 'node:assert/strict';

// La cle est derivee PARESSEUSEMENT, au premier chiffrement : poser le secret ici
// suffit, les imports statiques n'ont encore rien lu.
process.env.TOKEN_SECRET = 'secret-de-test-suffisamment-long-0123456789';

import { chiffrer, dechiffrer, estChiffre, chiffrementDisponible } from './crypto';
import { parseConfig, encodeConfig } from './config';

test('le chiffrement est disponible quand TOKEN_SECRET est pose', () => {
  assert.equal(chiffrementDisponible(), true);
});

test('aller-retour chiffrer/dechiffrer', () => {
  const donnees = { ad: 'CLE_AD_SECRETE', subLangs: ['fre'] };
  const blob = chiffrer(donnees);
  assert.ok(blob);
  assert.deepEqual(dechiffrer(blob), donnees);
});

test('la cle n apparait NULLE PART dans le blob', () => {
  // C'est tout l'objet de la manoeuvre : un lien colle en public ne doit pas livrer
  // une cle reutilisable ailleurs.
  const blob = chiffrer({ ad: 'CLE_AD_SECRETE' })!;
  assert.ok(!blob.includes('CLE_AD_SECRETE'));
  assert.ok(!Buffer.from(blob.split('.')[1], 'base64url').toString('latin1').includes('CLE_AD_SECRETE'));
});

test('deux chiffrements du meme contenu different (IV aleatoire)', () => {
  const a = chiffrer({ ad: 'X' });
  const b = chiffrer({ ad: 'X' });
  assert.notEqual(a, b);
});

test('un blob altere est refuse (chiffrement authentifie)', () => {
  const blob = chiffrer({ ad: 'X' })!;
  const corps = blob.split('.')[1];
  // On retourne un caractere du corps.
  const altere = `e1.${corps.slice(0, -2)}${corps.slice(-2, -1) === 'A' ? 'B' : 'A'}${corps.slice(-1)}`;
  assert.equal(dechiffrer(altere), null);
});

test('estChiffre distingue les deux formats', () => {
  assert.equal(estChiffre(chiffrer({ ad: 'X' })!), true);
  assert.equal(estChiffre(Buffer.from('{"ad":"X"}').toString('base64url')), false);
});

test('encodeConfig chiffre, et parseConfig relit', () => {
  const segment = encodeConfig({ ad: 'CLE', tb: 'AUTRE', sortBy: 'quality' });
  assert.ok(segment.startsWith('e1.'), 'le segment doit etre chiffre');
  assert.ok(!segment.includes('CLE'));

  const cfg = parseConfig(segment);
  assert.equal(cfg.ad, 'CLE');
  assert.equal(cfg.tb, 'AUTRE');
  assert.equal(cfg.sortBy, 'quality');
});

test('les anciens liens en clair restent lisibles', () => {
  // Compatibilite ascendante : un lien genere avant le chiffrement doit continuer
  // de fonctionner, sinon on casse les installations existantes.
  const ancien = Buffer.from(JSON.stringify({ ad: 'ANCIENNE_CLE' }), 'utf-8').toString('base64url');
  assert.equal(parseConfig(ancien).ad, 'ANCIENNE_CLE');
});

test('un blob chiffre illisible retombe sur les defauts sans exception', () => {
  const cfg = parseConfig('e1.nimportequoi');
  assert.equal(cfg.ad, undefined);
  assert.deepEqual(cfg.subLangs, ['fre', 'eng']);
});
