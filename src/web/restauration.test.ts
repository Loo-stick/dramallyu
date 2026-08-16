// Revenir sur /configure avec un lien existant doit REPEUPLER tous les reglages.
//
// Sinon le formulaire repart des valeurs par defaut, et regenerer le lien EFFACE
// silencieusement ce qu'on avait pose. C'est arrive sur cinq reglages d'un coup — dont
// la preference de debrideur, le filtre francais et le routage MediaFlow — sans qu'un
// seul message ne le signale : on rouvre la page, on clique « Generer », et on repart
// avec une configuration amputee.
//
// La liste des champs a repeupler etait implicite, tenue de memoire. Ce test la derive
// de `DEFAULT_CONFIG`, la seule source de verite : un reglage ajoute demain devra etre
// repeuple, ou ce test le dira.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../core/config';

const PAGE = readFileSync(join(import.meta.dirname, 'configure.html'), 'utf-8');

/**
 * Reglages volontairement absents du formulaire.
 *
 * `excludeQualities` n'a AUCUNE commande dans la page et son filtre
 * (`passesPreferences`) n'est appele nulle part : il a ete supplante par les bornes de
 * resolution. Il reste transportable pour ne pas casser les liens qui le portent.
 */
const SANS_COMMANDE = new Set(['excludeQualities']);

test('restaurer() repeuple chaque reglage transportable', () => {
  const corps = PAGE.match(/function restaurer\(\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(corps, 'fonction restaurer() introuvable');

  const oublies = Object.keys(DEFAULT_CONFIG).filter(
    (champ) => !SANS_COMMANDE.has(champ) && !corps.includes(champ),
  );
  assert.deepEqual(
    oublies,
    [],
    `reglages perdus a la regeneration : ${oublies.join(', ')}`,
  );
});

test('le pseudo et l uid sont repeuples eux aussi', () => {
  // Ils ne sont pas dans DEFAULT_CONFIG — ils ne sont pas des « reglages » — mais un
  // champ pseudo vide donne l'impression que l'identite a ete perdue, et l'uid est ce
  // qui relie une installation a ses traces.
  const corps = PAGE.match(/function restaurer\(\)\{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(corps.includes('pseudo'), 'le pseudo n est pas repeuple');
  assert.ok(corps.includes('uid'), 'l uid n est pas affiche');
});

test('la liste des exceptions ne couvre que des champs reels', () => {
  // Une exception qui ne correspond a rien signale un renommage oublie.
  for (const champ of SANS_COMMANDE) {
    assert.ok(champ in DEFAULT_CONFIG, `${champ} n'existe plus dans DEFAULT_CONFIG`);
  }
});
