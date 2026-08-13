import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toStremioStream, formatSize } from './display';
import type { Candidate } from '../sources/types';

function torrent(over: Partial<Candidate> = {}): Candidate {
  return {
    sourceId: 'c411',
    kind: 'torrent',
    title: 'Dune.Part.Two.2024.MULTi.2160p.UHD.BluRay.REMUX.HDR10.HEVC.TrueHD.7.1.Atmos-FraMeSToR',
    quality: '2160p',
    language: 'MULTI',
    sizeBytes: 58_200_000_000,
    seeders: 42,
    infoHash: 'a'.repeat(40),
    ...over,
  };
}

test('les quatre lignes sont produites dans l ordre attendu', () => {
  const s = toStremioStream(torrent(), { playUrl: 'https://x/resolve/t', viaDebrid: true, debrid: 'torbox', cached: true });
  const l = s.description.split('\n');

  assert.equal(s.name, '[TB ⚡] Dramallyu');
  assert.ok(l[0].startsWith('🎞️ 4K'), l[0]);
  assert.ok(l[0].includes('REMUX'), 'la source doit apparaitre');
  assert.ok(l[0].includes('HDR10'));
  assert.equal(s.name, '[TB ⚡] Dramallyu', 'le debrideur est dans l etiquette, pas dans la ligne 1');
  assert.ok(l[1].includes('🌐 MULTI') && l[1].includes('💾') && l[1].includes('👤 42'));
  assert.ok(l[2].includes('HEVC') && l[2].includes('TrueHD Atmos') && l[2].includes('FraMeSToR'));
  assert.ok(l[3].startsWith('🗂️'));
});

test('la langue porte un mot, pas seulement un drapeau', () => {
  // 🇫🇷 et 🇳🇱 ont la meme forme : sans le mot, l'information tient a la couleur.
  const vf = toStremioStream(torrent({ language: 'VF' }), {});
  assert.ok(vf.description.includes('🇫🇷 VF'));
  const vostfr = toStremioStream(torrent({ language: 'VOSTFR' }), {});
  assert.ok(vostfr.description.includes('🇫🇷 VOSTFR'));
  const vo = toStremioStream(torrent({ language: 'VO' }), {});
  assert.ok(vo.description.includes('VO'));
});

test('un segment inconnu est omis, jamais remplace par un trou', () => {
  const s = toStremioStream(
    torrent({ title: 'Drama S01E01', quality: 'HD', sizeBytes: undefined, seeders: undefined }),
    {},
  );
  assert.ok(!s.description.includes('• •'), 'aucun separateur orphelin');
  assert.ok(!/•\s*$/m.test(s.description), 'aucune ligne ne finit par un separateur');
});

test('une source directe n affiche pas de ligne codecs vide', () => {
  const direct: Candidate = {
    sourceId: 'kisskh',
    kind: 'direct',
    title: 'Squid Game Season 1',
    quality: '1080p',
    language: 'VOSTFR',
    directUrl: 'https://x/master.m3u8',
    subs: [
      { url: 'a', lang: 'fre', label: 'French' },
      { url: 'b', lang: 'eng', label: 'English' },
    ],
  };
  const s = toStremioStream(direct, { playUrl: 'https://x/master.m3u8' });
  const l = s.description.split('\n');
  assert.ok(!l.some((x) => x === '🎧 '), 'pas de ligne codecs vide');
  assert.ok(l[1].includes('KissKH'), 'la source figure sur la ligne langue/provenance');
  assert.ok(s.description.includes('💬 2 sous-titres dont FR'));
});

test('un DDL montre son hebergeur en fin de premiere ligne', () => {
  const ddl: Candidate = {
    sourceId: 'wawacity',
    kind: 'ddl',
    title: 'Squid Game - Saison 1 Épisode 3 - [VF HD]',
    quality: 'HD',
    language: 'VF',
    sizeBytes: 2_400_000_000,
    ddlUrl: 'https://dl-protect.link/x',
    ddlHost: 'Rapidgator',
  };
  const s = toStremioStream(ddl, { playUrl: 'https://x/resolve/t', viaDebrid: true, debrid: 'alldebrid' });
  assert.ok(s.description.split('\n')[0].includes('Rapidgator'));
  assert.ok(s.description.includes('Wawacity'));
});

test('la ligne fichier montre la release, pas le motif d episode', () => {
  // `fileHint` vaut « s01e09 » : c'est ce qui aide le debrideur a choisir dans un
  // pack, pas un nom de fichier. L'afficher donnait « 🗂️ s01e09 ».
  const s = toStremioStream(torrent({ fileHint: 's01e09' }), {});
  const l = s.description.split('\n').find((x) => x.startsWith('🗂️'))!;
  assert.ok(!l.includes('s01e09'));
  assert.ok(l.includes('Dune'));
  assert.ok(s.behaviorHints?.filename?.startsWith('Dune'), 'AIOStreams doit recevoir la release');
});

test('le nom de release est affiche EN ENTIER, jamais tronque', () => {
  // Tronquer coupe la fin — exactement la ou vivent le codec et la team qui
  // distinguent deux entrees par ailleurs identiques.
  const s = toStremioStream(torrent(), {});
  const ligneFichier = s.description.split('\n').find((l) => l.startsWith('🗂️'))!;
  assert.ok(!ligneFichier.includes('…'));
  assert.ok(ligneFichier.endsWith('FraMeSToR'), ligneFichier);
});

test('les tailles sont lisibles', () => {
  assert.equal(formatSize(2_400_000_000), '2.2 Go');
  assert.equal(formatSize(0), null);
  assert.equal(formatSize(undefined), null);
});

test('une qualite non mesuree est affichee telle quelle, pas promue en 1080p', () => {
  // normalizeQuality traduit « HD » en « 1080p » pour le TRI. L'afficher promettrait
  // une resolution qu'on ne connait pas.
  const s = toStremioStream(torrent({ title: 'Drama S01E01 HD', quality: 'HD' }), {});
  assert.ok(s.description.startsWith('🎞️ HD'), s.description.split('\n')[0]);
  assert.ok(!s.description.includes('1080p'));
});

test('une source directe ne se repete pas sur deux lignes', () => {
  const s = toStremioStream(
    { sourceId: 'voirdrama', kind: 'direct', title: 'VoirDrama - voe', quality: '1080p', language: 'VOSTFR', directUrl: 'https://x' },
    {},
  );
  const occurrences = (s.description.match(/VoirDrama/g) || []).length;
  assert.equal(occurrences, 1, 'le nom de la source ne doit apparaitre qu une fois');
  assert.ok(!s.description.includes('🗂️'), 'pas de ligne fichier pour un libelle fabrique');
});

test('l etiquette de tete nomme le debrideur et son etat', () => {
  assert.equal(toStremioStream(torrent(), { cached: true, debrid: 'torbox' }).name, '[TB ⚡] Dramallyu');
  assert.equal(toStremioStream(torrent(), { cached: false, debrid: 'torbox' }).name, '[TB ⏳] Dramallyu');
  assert.equal(toStremioStream(torrent(), { cached: true, debrid: 'alldebrid' }).name, '[AD ⚡] Dramallyu');
  // Disponibilite inconnue (un lien DDL) : on nomme le service sans rien promettre.
  assert.equal(toStremioStream(torrent(), { debrid: 'alldebrid' }).name, '[AD] Dramallyu');
});

test('un flux direct porte sa propre etiquette, sans debrideur', () => {
  const direct = toStremioStream(
    { sourceId: 'kisskh', kind: 'direct', title: 'Squid Game', quality: '1080p', language: 'VOSTFR', directUrl: 'https://x' },
    {},
  );
  assert.equal(direct.name, '[▶ ⚡] Dramallyu');
});

test('le ⚡ n apparait QU UNE fois, dans l etiquette', () => {
  // Il servait aussi de puce en tete de la ligne technique, ce qui le vidait de son
  // sens : chez les addons de streaming, ⚡ veut dire « en cache ».
  const s = toStremioStream(torrent(), { cached: true, debrid: 'torbox' });
  assert.equal((s.name + s.description).split('⚡').length - 1, 1);
});

// --- behaviorHints.filename : ce que lit AIOStreams ---------------------------
//
// Il analyse ce champ avec un parseur de noms de release et ne regarde la description
// QUE s'il est absent. Un titre nu lui fait sortir « Unknown Year », et son filtre
// « Year Matching » supprime le flux. Verifie dans ses journaux en production.

const OEUVRE = { annee: 2017, titreOeuvre: 'Sex Plate 17' };

test('un film sans nom de release recoit une annee entre parentheses', () => {
  const f = toStremioStream(
    { sourceId: 'kisskh', kind: 'direct', title: 'Sex Plate 17', quality: '1080p', language: 'VOSTFR' },
    { playUrl: 'http://x/y.m3u8', ...OEUVRE },
  ).behaviorHints!.filename!;
  assert.match(f, /\(2017\)/);
  assert.match(f, /1080p/);
  assert.match(f, /VOSTFR/);
});

test('une serie recoit SxxExx, pas la mention « Season N »', () => {
  const f = toStremioStream(
    { sourceId: 'kisskh', kind: 'direct', title: 'Squid Game Season 1', quality: '720p', language: 'VOSTFR' },
    { playUrl: 'http://x/y.m3u8', annee: 2021, saison: 1, episode: 9, titreOeuvre: 'Squid Game Season 1' },
  ).behaviorHints!.filename!;
  assert.match(f, /^Squid Game S01E09\b/);
  assert.doesNotMatch(f, /season/i, 'sinon on obtiendrait « Squid Game Season 1 S01E09 »');
});

test('un VRAI nom de release est laisse intact', () => {
  // Le reecrire ferait perdre le codec, la team et la provenance, que notre version
  // fabriquee n'a pas.
  const vrai = 'Squid Game S01 MULTi 1080p WEB x264 E-AC-3 -Tsundere-Raws';
  const f = toStremioStream(
    { sourceId: 'c411', kind: 'torrent', title: vrai, quality: '1080p', language: 'MULTI', infoHash: 'a'.repeat(40) },
    { playUrl: 'http://x/r', saison: 1, episode: 1, annee: 2021, titreOeuvre: 'Squid Game' },
  ).behaviorHints!.filename!;
  assert.equal(f, vrai);
});

test('le nom fabrique ne contient ni emoji ni puce', () => {
  // Le parseur ne les gere pas. Ce champ n'est pas de l'affichage.
  const f = toStremioStream(
    { sourceId: 'voirdrama', kind: 'direct', title: 'VoirDrama - voe', quality: 'HD', language: 'VOSTFR' },
    { playUrl: 'http://x/y', ...OEUVRE },
  ).behaviorHints!.filename!;
  assert.doesNotMatch(f, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}•]/u);
  assert.match(f, /^Sex Plate 17 \(2017\)/, 'meme un libelle fabrique par la source recoit un nom');
});

test('une resolution non mesuree est OMISE, jamais inventee', () => {
  // Ecrire « 1080p » de complaisance ferait trier AIOStreams sur une valeur fausse.
  const f = toStremioStream(
    { sourceId: 'kisskh', kind: 'direct', title: 'Sex Plate 17', quality: 'HD', language: 'VOSTFR' },
    { playUrl: 'http://x/y', ...OEUVRE },
  ).behaviorHints!.filename!;
  assert.doesNotMatch(f, /\d{3,4}p/);
  assert.match(f, /\(2017\)/, 'l annee reste, elle');
});

test('sans annee connue, on ecrit le nom sans annee plutot qu une annee fausse', () => {
  const f = toStremioStream(
    { sourceId: 'kisskh', kind: 'direct', title: 'Drama Inconnu', quality: '1080p', language: 'VOSTFR' },
    { playUrl: 'http://x/y' },
  ).behaviorHints!.filename!;
  assert.equal(f, 'Drama Inconnu 1080p VOSTFR');
});

test('l affichage n est pas touche par la fabrication du filename', () => {
  const s = toStremioStream(
    { sourceId: 'kisskh', kind: 'direct', title: 'Sex Plate 17', quality: '1080p', language: 'VOSTFR' },
    { playUrl: 'http://x/y', ...OEUVRE },
  );
  assert.equal(s.name, '[▶ ⚡] Dramallyu');
  assert.match(s.description, /🎞️ 1080p/);
  assert.match(s.behaviorHints!.bingeGroup!, /^dramallyu-kisskh-1080p-VOSTFR$/);
});
