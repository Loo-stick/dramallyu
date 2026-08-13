import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  normalizeTitle,
  bestMatch,
  matchesTitle,
  titreDiscriminant,
  formesUtiles,
  tokenSetScore,
} from './matching';

test('les ecritures asiatiques survivent a la tokenisation', () => {
  // Regression vecue en production. « 성판17: 남자들의 17가지 성적 판타지 » se reduisait
  // a « 1717 » : tous les caracteres coreens etaient effacés, il ne restait que les
  // chiffres. Effacer l'asiatique dans un addon de dramas asiatiques n'a pas de sens —
  // c'est la forme sous laquelle les titres originaux circulent.
  // On compare sur la forme NFD : la tokenisation decompose le hangul en jamos, si
  // bien qu'un littéral composé ne serait pas egal caractere pour caractere. Ce qui
  // compte est que le titre reste UN jeton porteur de sens, pas « 17 » tout seul.
  assert.deepEqual(tokenize('성판17'), ['성판17'.normalize('NFD')]);
  assert.equal(tokenSetScore('성판17', '성판17'), 1);
  assert.ok(tokenize('오징어 게임').length >= 2, 'le coreen reste tokenise');
  assert.ok(tokenize('鬼滅の刃').length > 0, 'le japonais reste');
  assert.ok(tokenize('เด็กใหม่').length > 0, 'le thai reste');
  assert.equal(normalizeTitle('Squid Game (2021)'), 'squidgame', 'le latin est inchange');
});

test('une forme de titre reduite a des chiffres ne vote pas', () => {
  // Le residu « 1717 » matchait tout titre contenant « 17 », et la preference pour le
  // titre le plus court faisait alors choisir « 17 Again » a la place de
  // « Sex Plate 17 » : la cle TMDB de l'utilisateur, en fournissant le titre coreen,
  // faisait PERDRE le bon film.
  assert.equal(titreDiscriminant('Sex Plate 17'), true);
  assert.equal(titreDiscriminant('1717'), false);
  assert.equal(titreDiscriminant('2024'), false);
  assert.deepEqual(formesUtiles(['Sex Plate 17', '1717']), ['Sex Plate 17']);
});

test('faute de mieux, on garde meme une forme faible', () => {
  // Sinon une oeuvre dont on ne connait que « 1717 » deviendrait introuvable : un match
  // faible vaut mieux que ne pas chercher du tout.
  assert.deepEqual(formesUtiles(['1717']), ['1717']);
});

test('le titre original ne fait pas perdre le bon candidat', () => {
  // Le scenario complet, tel qu'il s'est produit : meme liste de resultats, meme
  // seuil, la seule variable est l'ajout du titre coreen.
  const resultats = [
    { title: '17 Again' },
    { title: 'Sex Plate 17' },
    { title: 'Thirty But Seventeen - Still 17' },
  ];
  const ko = '성판17: 남자들의 17가지 성적 판타지';
  const seul = bestMatch(resultats, (r) => r.title, ['Sex Plate 17'], { year: 2017, threshold: 0.75 });
  const avecOriginal = bestMatch(resultats, (r) => r.title, ['Sex Plate 17', ko], { year: 2017, threshold: 0.75 });
  assert.equal(seul?.title, 'Sex Plate 17');
  assert.equal(avecOriginal?.title, 'Sex Plate 17', 'ajouter le titre original ne doit jamais degrader');
});
