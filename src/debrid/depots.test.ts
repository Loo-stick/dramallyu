// Ce que la verification depose doit toujours finir par repartir.
//
// La garde d'origine — « ne pas toucher a ce qui etait deja la » — protege les magnets
// de l'utilisateur, mais elle se retournait : des qu'un de NOS depots survivait a un
// passage, il figurait dans la photographie suivante, passait pour un magnet de
// l'utilisateur, et n'etait PLUS JAMAIS supprime. 377 magnets accumules, dont un en
// cours de telechargement que personne n'avait demande.
//
// Ce test decrit la decision, sans reseau : elle est le coeur du probleme.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Reproduit la regle appliquee dans `checkCached`. */
function aNous(hash: string, dejaLa: Set<string>, deposes: Set<string>): boolean {
  return !dejaLa.has(hash) || deposes.has(hash);
}

test('un depot inconnu du compte est a nous', () => {
  assert.equal(aNous('aa', new Set(), new Set()), true);
});

test('un magnet de l utilisateur n est jamais touche', () => {
  // Vecu : des telechargements lances depuis l'addon disparaissaient a la recherche
  // suivante. La photographie reste la protection de reference.
  assert.equal(aNous('bb', new Set(['bb']), new Set()), false);
});

test('un de nos depots reste a nous meme s il figure au compte', () => {
  // C'est le cas qui rendait la fuite definitive : suppression ratee, puis la
  // photographie suivante le montre et il devient intouchable.
  assert.equal(aNous('cc', new Set(['cc']), new Set(['cc'])), true);
});

test('une fois retire, il redevient protege', () => {
  // L'ensemble ne garde que ce qui n'est pas encore parti. Si l'utilisateur redepose
  // ensuite la meme empreinte en lisant un flux, elle lui appartient.
  const deposes = new Set(['dd']);
  deposes.delete('dd');
  assert.equal(aNous('dd', new Set(['dd']), deposes), false);
});
