// Les deux pages servies a un humain sont du HTML tenu a la main, avec tout leur
// script en un seul bloc. Consequence : une faute de syntaxe n'y casse pas une
// fonction, elle empeche le bloc ENTIER d'etre evalue. La page s'affiche, la mise en
// page est correcte, et rien ne fonctionne — aucun message, aucune trace serveur.
//
// C'est arrive : une apostrophe mal echappee dans un message d'information a vide le
// tableau de bord de ses chiffres. Le symptome ressemblait a une panne d'API, pas a
// une faute de frappe. Ces trois verifications tiennent en quelques millisecondes et
// rendent ce mode de panne impossible a livrer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

const DOSSIER = join(import.meta.dirname, '.');
const PAGES = readdirSync(DOSSIER).filter((f) => f.endsWith('.html'));

test('des pages sont bien presentes (le test ne passe pas a vide)', () => {
  assert.ok(PAGES.length >= 2, `pages trouvees : ${PAGES.join(', ')}`);
});

for (const page of PAGES) {
  const html = readFileSync(join(DOSSIER, page), 'utf-8');

  test(`${page} : le script est syntaxiquement valide`, () => {
    const blocs = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    for (const [, code] of blocs) {
      // Compiler suffit : on cherche une faute de syntaxe, pas a executer du DOM.
      assert.doesNotThrow(() => new vm.Script(code, { filename: page }));
    }
  });

  test(`${page} : les balises ouvertes sont refermees`, () => {
    for (const balise of ['script', 'style', 'section', 'table', 'details']) {
      const ouvertes = (html.match(new RegExp(`<${balise}[\\s>]`, 'g')) ?? []).length;
      const fermees = (html.match(new RegExp(`</${balise}>`, 'g')) ?? []).length;
      assert.equal(ouvertes, fermees, `${balise} : ${ouvertes} ouverte(s), ${fermees} fermee(s)`);
    }
  });

  test(`${page} : chaque onglet a la vue qui lui correspond`, () => {
    const onglets = [...html.matchAll(/data-vue="([a-z-]+)"/g)].map((m) => m[1]);
    for (const vue of new Set(onglets)) {
      assert.ok(
        html.includes(`id="vue-${vue}"`),
        `l'onglet « ${vue} » ne mene a aucune section id="vue-${vue}"`,
      );
    }
  });
}
