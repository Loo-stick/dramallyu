import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease, qualityOf, languageOf, seasonEpisodeOf, matchesEpisode } from './release';

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
