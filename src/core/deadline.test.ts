import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Deadline } from './http';

test('une echeance non atteinte laisse du temps', () => {
  const d = new Deadline(5000);
  assert.ok(d.remainingMs() > 4000);
  assert.equal(d.expired(), false);
  assert.equal(d.signal.aborted, false);
});

test('interrompre vaut echeance atteinte', () => {
  // Le rechauffement en arriere-plan doit pouvoir couper court a un travail devenu
  // inutile. Si `remainingMs` continuait d'annoncer du temps, la source engagerait des
  // requetes vouees a echouer au lieu de s'arreter.
  const d = new Deadline(60_000);
  d.arreter();
  assert.equal(d.remainingMs(), 0);
  assert.equal(d.expired(), true);
  assert.equal(d.signal.aborted, true);
});

test('un budget nul est expire d entree', () => {
  const d = new Deadline(0);
  assert.equal(d.expired(), true);
});

test('interrompre deux fois ne casse rien', () => {
  const d = new Deadline(1000);
  d.arreter();
  assert.doesNotThrow(() => d.arreter());
  assert.equal(d.expired(), true);
});
