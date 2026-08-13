import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marquerMort, estMort, filtrerMorts } from './deadlinks';

test('un lien marque mort est reconnu', () => {
  const url = `https://exemple.test/${Date.now()}`;
  assert.equal(estMort(url), false);
  marquerMort(url);
  assert.equal(estMort(url), true);
});

test('un lien jamais vu n est pas considere mort', () => {
  // Regle du projet : on ne coupe pas sur une information qu'on n'a pas.
  assert.equal(estMort(`https://inconnu.test/${Date.now()}`), false);
  assert.equal(estMort(''), false);
});

test('le filtrage retire les morts et garde le reste', () => {
  const vivant = `https://vivant.test/${Date.now()}`;
  const mort = `https://mort.test/${Date.now()}`;
  marquerMort(mort);
  const restants = filtrerMorts([{ u: vivant }, { u: mort }], (x) => x.u);
  assert.equal(restants.length, 1);
  assert.equal(restants[0].u, vivant);
});
