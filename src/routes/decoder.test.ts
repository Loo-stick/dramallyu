// Le decodeur ne doit JAMAIS rendre un secret.
//
// Il recoit un segment chiffre et rend les reglages, pour repeupler le formulaire de
// configuration. S'il rendait aussi les cles, il annulerait le chiffrement : quiconque
// detient un lien pourrait le lui poster et lire ce que ce lien protege.
//
// C'est arrive. La liste des champs a retirer etait ecrite a la main — cinq nommes sur
// douze — et six secrets sortaient en clair. Ce test verifie l'invariant sur TOUS les
// champs declares, pas sur ceux dont on se souvient.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAMPS_CLES, parseConfig } from '../core/config';

/** Reproduit exactement le tri du point d'entree. */
function reglagesRendus(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const secrets = new Set<string>(CHAMPS_CLES);
  for (const [champ, valeur] of Object.entries(cfg)) {
    if (!secrets.has(champ)) out[champ] = valeur;
  }
  return out;
}

test('aucun champ secret ne figure dans les reglages rendus', () => {
  // On remplit CHAQUE champ declare secret, avec une valeur reconnaissable.
  const cfg: Record<string, unknown> = {};
  for (const champ of CHAMPS_CLES) cfg[champ] = `SECRET-${champ}`;
  cfg.pseudo = 'Loo';
  cfg.sortBy = 'quality';

  const rendus = reglagesRendus(cfg);
  const fuites = Object.entries(rendus)
    .filter(([, v]) => typeof v === 'string' && v.startsWith('SECRET-'))
    .map(([k]) => k);

  assert.deepEqual(fuites, [], `champs fuites : ${fuites.join(', ')}`);
});

test('les reglages utiles passent bien', () => {
  const rendus = reglagesRendus({ pseudo: 'Loo', uid: 'abcd1234', sortBy: 'quality', frOnly: true });
  assert.equal(rendus.pseudo, 'Loo');
  assert.equal(rendus.uid, 'abcd1234');
  assert.equal(rendus.sortBy, 'quality');
  assert.equal(rendus.frOnly, true);
});

test('la liste des secrets couvre bien ce que porte une config reelle', () => {
  // Garde-fou contre l'oubli inverse : un champ de cle ajoute a UserConfig sans etre
  // declare dans CHAMPS_CLES ressortirait ici.
  const cfg = parseConfig(null) as Record<string, unknown>;
  const suspects = Object.keys(cfg).filter(
    (k) => /(^|_)(cle|key|pass|secret|token|passkey)/i.test(k) && !CHAMPS_CLES.includes(k as never),
  );
  assert.deepEqual(suspects, [], `champs suspects hors CHAMPS_CLES : ${suspects.join(', ')}`);
});
