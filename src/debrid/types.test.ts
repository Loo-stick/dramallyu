import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFile, episodeHint } from './types';

const f = (name: string, go = 2) => ({ name, sizeBytes: go * 1024 ** 3 });

const PACK = [
  f('Squid.Game.S01E01.Red.Light.Green.Light.1080p.NF.WEB-DL.mkv', 2.7),
  f('Squid.Game.S01E02.Hell.1080p.NF.WEB-DL.mkv', 2.5),
  f('Squid.Game.S01E09.One.Lucky.Day.1080p.NF.WEB-DL.mkv', 2.9),
  f('Squid Game S01/Subs/S01E01.fr.srt', 0.00002),
];

test('l episode demande est retrouve dans un pack', () => {
  assert.match(pickFile(PACK, episodeHint(1, 1))!.name, /S01E01/);
  assert.match(pickFile(PACK, episodeHint(1, 9))!.name, /S01E09/);
});

test('un episode ABSENT du pack ne rend pas un autre episode', () => {
  // Regression vecue : le repli « le plus gros fichier » s'appliquait meme quand on
  // cherchait un episode precis. Demander S01E05 rendait S01E01, silencieusement —
  // l'utilisateur lance sa lecture et tombe sur le mauvais episode, ce qui est pire
  // que de ne rien recevoir puisqu'il ne comprend pas pourquoi.
  assert.equal(pickFile(PACK, episodeHint(1, 5)), null);
});

test('les conventions de nommage alternatives sont reconnues', () => {
  // S'en tenir a SxxEyy ferait rejeter des packs valides, et on rendrait « rien »
  // la ou le fichier existe.
  const varie = [f('Drama 1x05 VOSTFR.mkv'), f('Drama 1x06 VOSTFR.mkv')];
  assert.match(pickFile(varie, episodeHint(1, 5))!.name, /1x05/);

  const tirets = [f('Mon.Drama - 05.mkv'), f('Mon.Drama - 06.mkv')];
  assert.match(pickFile(tirets, episodeHint(1, 5))!.name, /- 05/);

  const ep = [f('Drama.EP05.1080p.mkv'), f('Drama.EP06.1080p.mkv')];
  assert.match(pickFile(ep, episodeHint(1, 5))!.name, /EP05/);
});

test('le dossier qui annonce S01 ne fait pas passer n importe quel fichier', () => {
  // Le chemin porte « S01 » : chercher dans le chemin entier ferait correspondre le
  // premier fichier venu.
  const dossier = [f('Squid Game S01/episode.deux.mkv'), f('Squid Game S01/E01.mkv')];
  assert.match(pickFile(dossier, episodeHint(1, 1))!.name, /E01/);
});

test('sans indication, on prend la plus grosse video', () => {
  // Cas d'une release d'episode unique : le repli garde tout son sens, et il evite
  // de servir un echantillon de 30 Mo livre a cote.
  const solo = [f('Film.1080p.mkv', 8), f('echantillon.mkv', 0.03)];
  assert.match(pickFile(solo, undefined)!.name, /Film/);
});

test('un dossier sans aucune video rend null', () => {
  assert.equal(pickFile([f('lisezmoi.txt'), f('affiche.jpg')], episodeHint(1, 1)), null);
});
