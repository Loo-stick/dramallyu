// Repartition du budget de reponse entre sources ordinaires et directes.
//
// Ce calcul decide si une source de lecture apparait ou non. Il etait en ligne dans la
// requete, donc invisible aux tests, et son reglage a laisse une utilisatrice sans
// aucun flux sur un titre que l'addon savait pourtant servir.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { budgetsFanout } from './stream';

test('les ordinaires sont plafonnees en absolu', () => {
  // Elles rendent avant 2,2 s ; celles qui ne rendent jamais consomment tout leur
  // budget et fixent le temps de reponse. Les laisser croitre avec le total
  // ralentirait CHAQUE requete sans rien rapporter.
  assert.equal(budgetsFanout(6000).ordinaires, 2500);
  assert.equal(budgetsFanout(30000).ordinaires, 2500);
});

test('les directes profitent du budget total', () => {
  // C'est tout l'objet du sursis : a froid KissKH a mis 4750 ms.
  assert.ok(budgetsFanout(6000).directes >= 4750, 'le sursis ne couvre pas une KissKH froide');
});

test('les directes ont toujours au moins autant que les ordinaires', () => {
  for (const restant of [1000, 2000, 3500, 5000, 6000, 12000]) {
    const b = budgetsFanout(restant);
    assert.ok(
      b.directes >= b.ordinaires,
      `a ${restant} ms les directes (${b.directes}) passent sous les ordinaires (${b.ordinaires})`,
    );
  }
});

test('un budget derisoire garde un plancher utilisable', () => {
  // Sans plancher, un reglage trop bas coupe toutes les sources et l'addon rend une
  // liste vide sans rien dire.
  assert.equal(budgetsFanout(0).ordinaires, 1500);
  assert.equal(budgetsFanout(0).directes, 1500);
});
