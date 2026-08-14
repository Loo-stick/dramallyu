import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brancherJournal, lire, vider } from './journal';
import { tracer, traceCourante } from './trace';

brancherJournal();

test('une passkey journalisee n atteint ni la page ni la trace', async () => {
  // Le masquage n'est pas teste ici pour lui-meme (masque.test.ts s'en charge) mais
  // pour verifier qu'il est bien SUR LE CHEMIN. C'est la garantie qui autorise a
  // afficher ces lignes dans une page web et a les ecrire sur disque.
  vider();
  await tracer('Loo/abcd1234', async () => {
    console.log('[HTTP] api.yggreborn.org/api?passkey=SECRETABSOLU&q=drama');

    const journal = lire({ limite: 5 }).map((l) => l.texte).join('\n');
    assert.ok(!journal.includes('SECRETABSOLU'));
    assert.ok(journal.includes('passkey=***'));

    const trace = traceCourante();
    assert.ok(!trace.includes('SECRETABSOLU'));
    assert.ok(trace.includes('passkey=***'));
  });
});

test('la ligne rejoint le journal general ET la trace en cours', async () => {
  vider();
  await tracer('Loo/abcd1234', async () => {
    console.log('[KissKH] 12 candidats');
    assert.ok(lire({ limite: 5 }).some((l) => l.texte.includes('12 candidats')));
    assert.ok(traceCourante().includes('12 candidats'));
  });
});

test('hors requete, le journal fonctionne toujours', () => {
  vider();
  console.log('[Catalogue] rafraichissement');
  assert.ok(lire({ limite: 5 }).some((l) => l.texte.includes('rafraichissement')));
});

test('le prefixe et le niveau sont retenus', () => {
  vider();
  console.error('[Debrid] echec de resolution');
  const [l] = lire({ limite: 1 });
  assert.equal(l.source, 'Debrid');
  assert.equal(l.niveau, 'erreur');
});
