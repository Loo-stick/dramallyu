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
  const s = toStremioStream(torrent(), { playUrl: 'https://x/resolve/t', viaDebrid: true, debridName: 'TorBox' });
  const l = s.description.split('\n');

  assert.equal(s.name, 'Dramallyu');
  assert.ok(l[0].startsWith('⚡ 4K'), l[0]);
  assert.ok(l[0].includes('REMUX'), 'la source doit apparaitre');
  assert.ok(l[0].includes('HDR10'));
  assert.ok(l[0].includes('TorBox'), 'la ligne 1 se termine par la destination reelle');
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
  assert.ok(l[0].includes('KissKH'));
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
  const s = toStremioStream(ddl, { playUrl: 'https://x/resolve/t', viaDebrid: true, debridName: 'AllDebrid' });
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

test('un nom de fichier tres long est tronque', () => {
  const s = toStremioStream(torrent(), {});
  const ligneFichier = s.description.split('\n').find((l) => l.startsWith('🗂️'))!;
  assert.ok(ligneFichier.length < 60);
  assert.ok(ligneFichier.endsWith('…'));
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
  assert.ok(s.description.startsWith('⚡ HD'), s.description.split('\n')[0]);
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
