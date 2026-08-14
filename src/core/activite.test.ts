// On designe une base temporaire avant le premier appel.
//
// Cela suppose que le module n'ouvre RIEN a l'import : en modules ES, les imports sont
// evalues avant la premiere instruction de ce fichier, donc une base ouverte au
// chargement serait deja la mauvaise. Les premieres executions de ce test ont d'ailleurs
// insere leurs Alice et Bob dans la base de PRODUCTION, sans qu'aucun signal ne le
// montre — c'est ce qui a fait passer `activite.ts` a une ouverture paresseuse.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { enregistrer, resumeUtilisateurs, requetesDe, traceDe, oublier, purger } from './activite';

process.env.ACTIVITE_DB_PATH = `${process.env.TMPDIR || '/tmp'}/dramallyu-activite-test-${process.pid}.db`;

after(() => {
  for (const suffixe of ['', '-wal', '-shm']) {
    try {
      unlinkSync(process.env.ACTIVITE_DB_PATH + suffixe);
    } catch {
      /* deja absent */
    }
  }
});

test('enregistre une recherche et la relit', () => {
  enregistrer({ qui: 'Alice/1111', type: 'series', contenu: 'tt1:1:1', titre: 'Squid Game', flux: 4, issue: 'ok', ms: 900 });
  const r = requetesDe('Alice/1111');
  assert.equal(r.length, 1);
  assert.equal(r[0].titre, 'Squid Game');
  assert.equal(r[0].flux, 4);
  assert.equal(r[0].issue, 'ok');
});

test('une recherche anonyme n est pas conservee', () => {
  // Sans identite, la ligne ne peut servir a aucun diagnostic individuel : la garder
  // ne ferait que grossir la base.
  enregistrer({ qui: '', flux: 0, issue: 'vide' });
  assert.equal(requetesDe('').length, 0);
});

test('la trace se demande a la ligne, pas avec la liste', () => {
  enregistrer({ qui: 'Bob/2222', titre: 'Pursuit of Jade', flux: 0, issue: 'vide', trace: '10:00:00 [C411] 0 candidat' });
  const [ligne] = requetesDe('Bob/2222');
  // La liste annonce l'existence de la trace, sans la transporter.
  assert.equal(ligne.aUneTrace, 1);
  assert.ok(!('trace' in ligne));
  assert.ok(traceDe(ligne.id)?.includes('[C411]'));
});

test('distingue « pas de trace » de « trace vide »', () => {
  enregistrer({ qui: 'Bob/2222', titre: 'Sans trace', flux: 3, issue: 'ok' });
  const [ligne] = requetesDe('Bob/2222');
  assert.equal(ligne.aUneTrace, 0);
  assert.equal(traceDe(ligne.id), null);
});

test('le resume compte chaque issue separement', () => {
  enregistrer({ qui: 'Carla/3333', flux: 0, issue: 'vide' });
  enregistrer({ qui: 'Carla/3333', flux: 0, issue: 'erreur' });
  enregistrer({ qui: 'Carla/3333', flux: 0, issue: 'hors-creneau' });
  enregistrer({ qui: 'Carla/3333', flux: 7, issue: 'ok' });

  const c = resumeUtilisateurs().find((u) => u.qui === 'Carla/3333');
  assert.ok(c);
  assert.equal(c.requetes, 4);
  assert.equal(c.vides, 1);
  assert.equal(c.erreurs, 1);
  // Hors creneau compte a part : c'est le fonctionnement normal, pas un incident.
  assert.equal(c.horsCreneau, 1);
  // Les ennuis recents ne retiennent que les deux issues qui en sont.
  assert.equal(c.soucisRecents, 2);
});

test('les installations en difficulte passent en tete', () => {
  for (let i = 0; i < 5; i++) enregistrer({ qui: 'Calme/4444', flux: 2, issue: 'ok' });
  const noms = resumeUtilisateurs().map((u) => u.qui);
  assert.ok(noms.indexOf('Carla/3333') < noms.indexOf('Calme/4444'));
});

test('oublier efface toute l activite d une installation, et d elle seule', () => {
  const avant = requetesDe('Alice/1111').length;
  assert.ok(avant > 0);
  const n = oublier('Alice/1111');
  assert.equal(n, avant);
  assert.equal(requetesDe('Alice/1111').length, 0);
  assert.ok(requetesDe('Bob/2222').length > 0);
});

test('purger ne retire rien tant que rien n a expire', () => {
  assert.equal(purger(), 0);
});
