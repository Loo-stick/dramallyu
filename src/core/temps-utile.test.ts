// Deux horloges courent pendant un fan-out : le budget de FOND (huit secondes, qui
// sert au rechauffement apres la reponse) et l'echeance de la REPONSE, bien plus
// courte. Le travail facultatif doit se regler sur la seconde.
//
// Les sources lisaient toutes le budget de fond. KissKH a froid mettait 5357 ms a
// rendre son flux sur « Signal » — dont une bonne part de mesure de qualite engagee
// parce qu'elle se croyait huit secondes devant elle — pour une reponse coupee a
// 5100 ms. On perdait le flux entier pour affiner une etiquette.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tempsUtile } from './registry';

test('avant la reponse, c est la plus courte des deux horloges', () => {
  assert.equal(tempsUtile(8000, 5100), 5100);
  assert.equal(tempsUtile(1200, 5100), 1200);
});

test('passe la reponse, le budget de fond reprend la main', () => {
  // Rechauffement : la reponse est partie, plus rien ne presse, et c'est justement le
  // moment de faire le travail complet pour que le cache serve la fois suivante.
  assert.equal(tempsUtile(6000, 0), 6000);
  assert.equal(tempsUtile(6000, -1500), 6000);
});

test('un travail facultatif exigeant 2500 ms est refuse quand il ne rentre pas', () => {
  // C'est la decision concrete que prend la mesure de qualite.
  assert.ok(tempsUtile(8000, 2000) < 2500, 'engage un travail qui depasse la reponse');
  assert.ok(tempsUtile(8000, 4000) >= 2500, 'refuse un travail qui tenait pourtant');
});
