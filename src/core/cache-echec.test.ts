// Un echec ne doit JAMAIS etre memorise — meme pas au TTL negatif.
//
// Le TTL negatif existe pour ne pas matraquer une source qui a repondu « rien ». Un
// appel qui a ECHOUE est une autre affaire : ce n'est pas une information, c'est son
// absence. Les confondre transforme un incident passager en panne durable, et pour les
// sources a cle — dont la cle de cache est volontairement PARTAGEE entre utilisateurs —
// une seule cle expiree suffit alors a faire passer le tracker pour vide aux yeux de
// tous les autres.
//
// C'est arrive en essayant une cle invalide sur DarkPeers : l'essai suivant, avec une
// cle VALIDE, a lu la reponse vide memorisee et a rendu 0 candidat en 1 ms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cached, clearScope } from './cache';

const PORTEE = 'test-echec';

test('un echec n est pas memorise, meme avec un TTL negatif', async () => {
  clearScope(PORTEE);
  let appels = 0;

  const interroger = () =>
    cached<string[] | null>(
      'echec:1',
      60_000,
      async () => {
        appels++;
        return null; // l'appel a echoue
      },
      { scope: PORTEE, echec: (v) => v === null, shouldCache: (v) => v !== null && v.length > 0, negativeTtlMs: 60_000 },
    );

  assert.equal(await interroger(), null);
  assert.equal(await interroger(), null);
  // Le second appel doit avoir REELLEMENT retente : rien n'a ete memorise.
  assert.equal(appels, 2);
});

test('un vide authentique reste memorise au TTL negatif', async () => {
  clearScope(PORTEE);
  let appels = 0;

  const interroger = () =>
    cached<string[] | null>(
      'vide:1',
      60_000,
      async () => {
        appels++;
        return []; // le tracker a repondu : il n'a rien
      },
      { scope: PORTEE, echec: (v) => v === null, shouldCache: (v) => v !== null && v.length > 0, negativeTtlMs: 60_000 },
    );

  assert.deepEqual(await interroger(), []);
  assert.deepEqual(await interroger(), []);
  // Une seule interrogation : le vide, lui, est une information qu'on garde.
  assert.equal(appels, 1);
});

test('un resultat utile est memorise au TTL normal', async () => {
  clearScope(PORTEE);
  let appels = 0;

  const interroger = () =>
    cached<string[] | null>(
      'plein:1',
      60_000,
      async () => {
        appels++;
        return ['un'];
      },
      { scope: PORTEE, echec: (v) => v === null, shouldCache: (v) => v !== null && v.length > 0 },
    );

  assert.deepEqual(await interroger(), ['un']);
  assert.deepEqual(await interroger(), ['un']);
  assert.equal(appels, 1);
  clearScope(PORTEE);
});
