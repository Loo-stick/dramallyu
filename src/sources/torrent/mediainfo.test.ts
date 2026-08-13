import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languesSousTitres, codeDeLangue } from './mediainfo';

/** Extrait reel, raccourci : deux pistes audio et trois pistes texte. */
const DUMP = [
  'General',
  'Complete name                            : Squid.Game.S01E01.1080p.NF.WEB-DL.mkv',
  '',
  'Video',
  'Format                                   : AVC',
  '',
  'Audio #1',
  'Format                                   : E-AC-3',
  'Language                                 : Korean',
  '',
  'Audio #2',
  'Format                                   : E-AC-3',
  'Language                                 : English',
  '',
  'Text #1',
  'Codec ID                                 : S_TEXT/UTF8',
  'Language                                 : Korean',
  '',
  'Text #2',
  'Codec ID                                 : S_TEXT/UTF8',
  'Title                                    : French Dub (SDH)',
  'Language                                 : French',
  '',
  'Text #3',
  'Codec ID                                 : S_TEXT/UTF8',
  'Language                                 : Chinese (Traditional)',
  '',
  'Menu',
  '00:00:00.000                             : en:Main',
].join('\n');

test('seules les pistes TEXTE comptent', () => {
  // Confondre avec l'audio annoncerait du francais sur une release doublee sans
  // sous-titres — exactement la confusion qu'on cherche a lever.
  const langues = languesSousTitres(DUMP);
  assert.deepEqual(langues.sort(), ['chi', 'fre', 'kor']);
  assert.equal(langues.includes('eng'), false, 'l anglais n est QUE sur une piste audio');
});

test('les qualificatifs entre parentheses ne creent pas de doublon', () => {
  // « Chinese (Traditional) » et « Chinese » designent la meme langue au regard de la
  // seule question posee : cette release porte-t-elle ma langue ?
  assert.equal(codeDeLangue('Chinese (Traditional)'), 'chi');
  assert.equal(codeDeLangue('Spanish (Latin America)'), 'spa');
  assert.equal(codeDeLangue('French'), 'fre');
});

test('un libelle inconnu est ignore, pas devine', () => {
  assert.equal(codeDeLangue('Klingon'), null);
  assert.equal(codeDeLangue(''), null);
});

test('un MediaInfo vide ou absent ne rend rien', () => {
  assert.deepEqual(languesSousTitres(''), []);
  assert.deepEqual(languesSousTitres('General\nFormat : Matroska'), []);
});
