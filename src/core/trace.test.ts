import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tracer, traceCourante, quiCourant, capturerLigne } from './trace';

test('les lignes rejoignent la trace de la requete en cours', async () => {
  await tracer('Loo/abcd1234', async () => {
    capturerLigne('[KissKH] 12 candidats');
    capturerLigne('[Stream] 4 flux');
    const t = traceCourante();
    assert.ok(t.includes('[KissKH] 12 candidats'));
    assert.ok(t.includes('[Stream] 4 flux'));
    assert.equal(quiCourant(), 'Loo/abcd1234');
  });
});

test('hors requete, capturer ne fait rien et ne casse rien', () => {
  assert.doesNotThrow(() => capturerLigne('ligne orpheline'));
  assert.equal(traceCourante(), '');
  assert.equal(quiCourant(), undefined);
});

test('deux requetes concurrentes ne melangent pas leurs traces', async () => {
  // C'est LA propriete qui justifie ce fichier : sur un addon partage, plusieurs
  // recherches se chevauchent, et le journal general les entrelace. Si cette
  // separation ne tenait pas, la trace « par utilisateur » serait un mensonge.
  const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const a = tracer('Alice/1111', async () => {
    capturerLigne('A1');
    await attendre(20);
    capturerLigne('A2');
    return traceCourante();
  });
  const b = tracer('Bob/2222', async () => {
    await attendre(10);
    capturerLigne('B1');
    await attendre(20);
    capturerLigne('B2');
    return traceCourante();
  });

  const [traceA, traceB] = await Promise.all([a, b]);
  assert.ok(traceA.includes('A1') && traceA.includes('A2'));
  assert.ok(!traceA.includes('B1') && !traceA.includes('B2'));
  assert.ok(traceB.includes('B1') && traceB.includes('B2'));
  assert.ok(!traceB.includes('A1') && !traceB.includes('A2'));
});

test('la trace est bornee, et le dit quand elle tronque', async () => {
  await tracer('Loo/abcd1234', async () => {
    for (let i = 0; i < 500; i++) capturerLigne(`ligne ${i}`);
    const t = traceCourante();
    assert.ok(t.includes('trace tronquee'));
    // Bien en dessous des 500 lignes emises : la borne tient.
    assert.ok(t.split('\n').length < 200);
    // Ce sont les PREMIERES qui sont gardees : elles disent ce que la requete a tente.
    assert.ok(t.includes('ligne 0'));
    assert.ok(!t.includes('ligne 499'));
  });
});

test('une trace imbriquee reste dans son propre contexte', async () => {
  await tracer('Externe/1', async () => {
    capturerLigne('externe');
    await tracer('Interne/2', async () => {
      capturerLigne('interne');
      assert.equal(quiCourant(), 'Interne/2');
      assert.ok(!traceCourante().includes('externe'));
    });
    assert.equal(quiCourant(), 'Externe/1');
    assert.ok(!traceCourante().includes('interne'));
  });
});
