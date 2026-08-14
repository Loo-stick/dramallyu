import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease, qualityOf, languageOf, seasonEpisodeOf, matchesEpisode, absoluDe } from './release';

test('qualite lue dans le nom de release', () => {
  assert.equal(qualityOf('Squid.Game.S01E09.2160p.WEB-DL'), '4K');
  assert.equal(qualityOf('Squid.Game.S01E09.1080p.WEB-DL'), '1080p');
  assert.equal(qualityOf('Drama.720p.HDTV'), '720p');
  assert.equal(qualityOf('Drama.WEB-DL'), 'HD');
});

test('langue : MULTI et VOSTFR priment sur VF', () => {
  assert.equal(languageOf('Squid.Game.S01E09.MULTi.1080p'), 'MULTI');
  assert.equal(languageOf('Drama.S01E01.VOSTFR.1080p'), 'VOSTFR');
  assert.equal(languageOf('Drama.S01E01.TRUEFRENCH.1080p'), 'VF');
  assert.equal(languageOf('Drama.S01E01.1080p.NF.WEB-DL'), 'VO');
});

test('les sous-titres FR annonces valent VOSTFR', () => {
  assert.equal(languageOf('K-Drama E01 [FR] 1080p'), 'VOSTFR');
  assert.equal(languageOf('C-Drama E01 french sub 720p'), 'VOSTFR');
});

test('saison/episode dans les graphies courantes', () => {
  assert.deepEqual(seasonEpisodeOf('Squid.Game.S01E09.1080p'), { season: 1, episode: 9 });
  assert.deepEqual(seasonEpisodeOf('Drama 2x05 VOSTFR'), { season: 2, episode: 5 });
  assert.deepEqual(seasonEpisodeOf('Drama Saison 3 Episode 12'), { season: 3, episode: 12 });
  assert.deepEqual(seasonEpisodeOf('Drama S01 E7'), { season: 1, episode: 7 });
});

test('un pack de saison est reconnu comme tel', () => {
  const pack = parseRelease('Squid.Game.S01.COMPLETE.MULTi.1080p.WEB-DL');
  assert.equal(pack.episode, null);
  assert.equal(pack.season, 1);
  assert.equal(pack.isPack, true);
});

test('une release d episode n est jamais prise pour un pack', () => {
  const ep = parseRelease('Squid.Game.S01E09.MULTi.1080p');
  assert.equal(ep.isPack, false);
});

test('on accepte l episode exact', () => {
  assert.equal(matchesEpisode(parseRelease('Drama.S01E09.1080p'), 1, 9), true);
});

test('on refuse un autre episode ou une autre saison', () => {
  assert.equal(matchesEpisode(parseRelease('Drama.S01E08.1080p'), 1, 9), false);
  assert.equal(matchesEpisode(parseRelease('Drama.S02E09.1080p'), 1, 9), false);
});

test('on accepte un pack de la bonne saison', () => {
  assert.equal(matchesEpisode(parseRelease('Drama.S01.COMPLETE.1080p'), 1, 9), true);
  assert.equal(matchesEpisode(parseRelease('Drama.S02.COMPLETE.1080p'), 1, 9), false);
});

test('un film (sans saison demandee) passe toujours', () => {
  assert.equal(matchesEpisode(parseRelease('Old.Boy.2003.1080p.MULTi'), undefined, undefined), true);
});

test('format Nyaa : « Titre - 09 » est reconnu comme episode 9', () => {
  assert.deepEqual(seasonEpisodeOf('[TeamFR] Squid Game - 09 [1080p]'), { season: null, episode: 9 });
  assert.deepEqual(seasonEpisodeOf('[Team] Drama - 5 (720p).mkv'), { season: null, episode: 5 });
});

test('le repli Nyaa ne confond pas une resolution ou une annee avec un episode', () => {
  assert.equal(seasonEpisodeOf('Drama.WEB-DL.1080p').episode, null);
  assert.equal(seasonEpisodeOf('Old Boy - 2003 [1080p]').episode, null);
  assert.equal(seasonEpisodeOf('Drama - 720p').episode, null);
});

test('un episode Nyaa passe le controle de correspondance', () => {
  assert.equal(matchesEpisode(parseRelease('[TeamFR] Squid Game - 09 [1080p]'), 1, 9), true);
  assert.equal(matchesEpisode(parseRelease('[TeamFR] Squid Game - 08 [1080p]'), 1, 9), false);
});

/* ------------------------------------------------------------------------- *
 * Structure lue par `structure.ts` (Parsium).
 *
 * Ces cas sont ceux qu'on ratait AVANT, mesures sur des titres reels. Ils tiennent
 * ici plutot que dans un test dedie a la dependance : ce qui compte n'est pas qu'une
 * bibliotheque reponde, c'est que `parseRelease` rende le bon resultat.
 * ------------------------------------------------------------------------- */

test('forme francaise « Saison 1 Épisode 4 » : ce n est PAS un pack', () => {
  // Vecu en production : l'episode n'etait pas lu, donc `isPack` passait a vrai et un
  // episode isole etait annonce comme une saison entiere.
  const r = parseRelease('Crash Landing on You - Saison 1 Épisode 4 - [VOSTFR] — Rapidgator');
  assert.equal(r.season, 1);
  assert.equal(r.episode, 4);
  assert.equal(r.isPack, false);
});

test('forme francaise avec accent et sans, meme lecture', () => {
  for (const nom of [
    'Squid Game - Saison 1 Épisode 1 - [VF HD] — Vidoza',
    'Squid Game - Saison 1 Episode 1 - [VOSTFR] — Uploady',
  ]) {
    const r = parseRelease(nom);
    assert.equal(r.episode, 1, nom);
    assert.equal(r.isPack, false, nom);
  }
});

test('saison sur une forme non standard', () => {
  assert.equal(parseRelease('Soul Land II 2nd Season - 08 VOSTFR 1080p').season, 2);
});

test('numero absolu reconnu, et seulement sans saison', () => {
  const donghua = parseRelease('[Sakura] Battle Through the Heavens - 156 [1080p]');
  assert.equal(donghua.absolu, 156);
  assert.equal(donghua.season, null);

  // Un episode annonce avec sa saison n'est PAS absolu : son numero appartient a la
  // saison. Confondre les deux ferait servir n'importe quoi.
  const classique = parseRelease('Squid Game S02E13 1080p WEB-DL');
  assert.equal(classique.absolu, null);
  assert.equal(classique.season, 2);
  assert.equal(classique.episode, 13);
});

test('un pack de saison reste un pack', () => {
  const r = parseRelease('Crash.Landing.On.You.S01.MULTI.VFF.1080p.WEB.EAC3.H264-kimiko');
  assert.equal(r.isPack, true);
  assert.equal(r.episode, null);
});

test('INTEGRALE reste reconnu par notre repli', () => {
  assert.equal(parseRelease('Crash.Landing.On.You.INTEGRALE.VOSTFR.1080p.WEB.x265').isPack, true);
});

test('la LANGUE reste la notre : « MULTi » nu vaut MULTI', () => {
  // La bibliotheque n'affirme aucune langue sur un « MULTi » nu. Sur la scene FR,
  // le jeton implique le francais — c'est notre public, et 13 % des releases reelles
  // perdraient leur etiquette si on la lui confiait.
  assert.equal(parseRelease('Parasite.2019.MULTi.1080p.BluRay.x264-FRX').language, 'MULTI');
  assert.equal(parseRelease('Squid Game - Saison 1 Épisode 1 - [VF HD]').language, 'VF');
});

/* ----------------------- correspondance d episode ------------------------ */

test('un numero absolu correspond a la bonne saison', () => {
  const r = parseRelease('[Sakura] Renegade Immortal - 42 [1080p]');
  const compte = { 1: 30, 2: 20 };
  // 42 = 30 (saison 1) + 12 -> saison 2, episode 12.
  assert.equal(matchesEpisode(r, 2, 12, compte), true);
  // Le voisin immediat doit etre refuse : c'est la ou une conversion approximative
  // ferait servir le mauvais episode.
  assert.equal(matchesEpisode(r, 2, 11, compte), false);
  assert.equal(matchesEpisode(r, 2, 13, compte), false);
  // Et une autre saison ne doit pas y repondre non plus.
  assert.equal(matchesEpisode(r, 1, 12, compte), false);
});

test('sans compte d episodes, on ne devine pas', () => {
  // Servir le mauvais episode est la pire faute possible : en l'absence de preuve,
  // on refuse plutot que de supposer.
  const r = parseRelease('[Sakura] Renegade Immortal - 42 [1080p]');
  assert.equal(matchesEpisode(r, 2, 12), false);
});

test('un compte incomplet ne conclut pas', () => {
  const r = parseRelease('[Sakura] Renegade Immortal - 42 [1080p]');
  assert.equal(matchesEpisode(r, 3, 5, { 1: 30 }), false);
});

test('absoluDe additionne les saisons anterieures', () => {
  assert.equal(absoluDe(1, 5, { 1: 12 }), 5);
  assert.equal(absoluDe(2, 3, { 1: 12, 2: 12 }), 15);
  assert.equal(absoluDe(3, 1, { 1: 12 }), null);
});
