import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passeFiltres, comparer, estCam, contientFormat, rangResolution, rangSource } from './filters';
import type { Filtres, EtatFlux, OptionsTri } from './filters';
import type { Candidate } from '../sources/types';

const NEUTRE: Filtres = {
  cachedOnly: false,
  minResolution: '',
  maxResolution: '',
  minSource: '',
  maxSizeGb: 0,
  excludeFormats: [],
  excludeCam: false,
};

function flux(over: Partial<Candidate> = {}, cached?: boolean): EtatFlux {
  return {
    candidate: {
      sourceId: 'c411',
      kind: 'torrent',
      title: 'Drama.S01E01.MULTi.1080p.WEB-DL.HEVC.EAC3-TEAM',
      quality: '1080p',
      language: 'MULTI',
      sizeBytes: 3 * 1024 ** 3,
      infoHash: 'a'.repeat(40),
      ...over,
    },
    cached,
  };
}

test('filtres neutres : tout passe', () => {
  assert.equal(passeFiltres(flux(), NEUTRE), true);
});

test('« seulement le cache » ne garde que ce qui est VERIFIE present', () => {
  const f = { ...NEUTRE, cachedOnly: true };
  assert.equal(passeFiltres(flux({}, true), f), true);
  assert.equal(passeFiltres(flux({}, false), f), false);
  // Invérifiable (lien DDL sans hash) : ecarte aussi, mais ce n'est pas la meme
  // chose — l'utilisateur a demande « seulement ce qui est sur ».
  assert.equal(passeFiltres(flux({}, undefined), f), false);
});

test('un flux DIRECT passe toujours « seulement ce qui est pret »', () => {
  // Regression vecue : un drama parfaitement servi par KissKH rendait une liste vide.
  // Le flux direct ne traverse aucun debrideur, donc il n'a pas d'etat de cache — et
  // il est pourtant le plus immediat de tous. L'ecarter etait un contresens, visible
  // dans l'interface qui lui affiche « ▶ ⚡ ».
  const f = { ...NEUTRE, cachedOnly: true };
  assert.equal(passeFiltres(flux({ kind: 'direct', infoHash: undefined }, undefined), f), true);
});

test('bornes de resolution', () => {
  const f = { ...NEUTRE, minResolution: '720p', maxResolution: '1080p' };
  assert.equal(passeFiltres(flux({ quality: '1080p' }), f), true);
  assert.equal(passeFiltres(flux({ quality: '720p' }), f), true);
  assert.equal(passeFiltres(flux({ quality: '480p' }), f), false);
  assert.equal(passeFiltres(flux({ quality: '4K' }), f), false);
});

test('une resolution NON MESUREE passe les bornes', () => {
  // Regle du projet : on ne coupe pas sur ce qu'on ne sait pas. Sinon les sources
  // qui n'annoncent que « HD » disparaitraient des qu'un plancher est pose.
  const f = { ...NEUTRE, minResolution: '1080p' };
  assert.equal(passeFiltres(flux({ quality: 'HD' }), f), true);
  assert.equal(rangResolution('HD'), null);
});

test('taille maximale', () => {
  const f = { ...NEUTRE, maxSizeGb: 5 };
  assert.equal(passeFiltres(flux({ sizeBytes: 3 * 1024 ** 3 }), f), true);
  assert.equal(passeFiltres(flux({ sizeBytes: 9 * 1024 ** 3 }), f), false);
  // Taille inconnue : on ne peut pas trancher, donc on garde.
  assert.equal(passeFiltres(flux({ sizeBytes: undefined }), f), true);
});

test('exclusion de formats', () => {
  const f = { ...NEUTRE, excludeFormats: ['HEVC'] };
  assert.equal(passeFiltres(flux(), f), false);
  assert.equal(passeFiltres(flux({ title: 'Drama.S01E01.1080p.WEB-DL.x264-TEAM' }), f), true);
});

test('un format tape a la main est cherche comme un MOT', () => {
  // Sinon « DD » ferait disparaitre tous les « DDP5.1 », et pire, « Squid ».
  assert.equal(contientFormat('Drama.DDP5.1.x264', 'DD'), false);
  assert.equal(contientFormat('Drama.DD5.1.x264', 'DD5'), true);
  assert.equal(contientFormat('Drama.1080p.AV1', 'AV1'), true);
});

test('captations en salle reconnues et exclues', () => {
  assert.equal(estCam('Film.2024.HDCAM.1080p'), true);
  assert.equal(estCam('Film.2024.TS.MULTi'), true);
  assert.equal(estCam('Film.2024.WEB-DL.1080p'), false);
  const f = { ...NEUTRE, excludeCam: true };
  assert.equal(passeFiltres(flux({ title: 'Film.2024.HDCAM.MULTi' }), f), false);
});

test('qualite de source plancher, independante de la resolution', () => {
  // Un CAM annonce en 1080p reste un CAM : les deux echelles ne se confondent pas.
  const f = { ...NEUTRE, minSource: 'WEBRip' };
  assert.equal(passeFiltres(flux({ title: 'Film.2024.HDCAM.1080p', quality: '1080p' }), f), false);
  assert.equal(passeFiltres(flux({ title: 'Film.2024.BluRay.720p', quality: '720p' }), f), true);
  assert.equal(rangSource('Film.REMUX.2160p')! > rangSource('Film.WEBRip.1080p')!, true);
});

const TRI: OptionsTri = { langOrder: ['VOSTFR', 'VF', 'MULTI', 'VO'], sortBy: 'language', priorite: 'aucune', bonusHdr: false };

test('ce qui est pret passe devant tout le reste', () => {
  const pret = flux({ language: 'VO' }, true);
  const pasPret = flux({ language: 'VOSTFR' }, false);
  assert.ok(comparer(pret, pasPret, TRI) < 0, 'le pret precede, meme avec une moins bonne langue');
});

test('la priorite de pilier passe avant le critere de tri', () => {
  const direct = flux({ kind: 'direct', language: 'VO', quality: '480p' });
  const torrent = flux({ kind: 'torrent', language: 'VOSTFR', quality: '4K' });
  assert.ok(comparer(direct, torrent, { ...TRI, priorite: 'direct' }) < 0);
  assert.ok(comparer(torrent, direct, { ...TRI, priorite: 'torrent' }) < 0);
});

test('tri « leger » : le plus petit d abord', () => {
  const petit = flux({ sizeBytes: 1 * 1024 ** 3 });
  const gros = flux({ sizeBytes: 20 * 1024 ** 3 });
  assert.ok(comparer(petit, gros, { ...TRI, sortBy: 'size' }) < 0);
});

test('une taille inconnue ne passe pas pour un fichier de 0 octet', () => {
  const inconnu = flux({ sizeBytes: undefined });
  const connu = flux({ sizeBytes: 20 * 1024 ** 3 });
  assert.ok(comparer(inconnu, connu, { ...TRI, sortBy: 'size' }) > 0, 'l inconnu part en fin');
});

test('le bonus HDR departage a resolution egale', () => {
  const hdr = flux({ title: 'Drama.S01E01.1080p.WEB-DL.HDR10.x265' });
  const sans = flux({ title: 'Drama.S01E01.1080p.WEB-DL.x265' });
  assert.ok(comparer(hdr, sans, { ...TRI, sortBy: 'quality', bonusHdr: true }) < 0);
  assert.equal(comparer(hdr, sans, { ...TRI, sortBy: 'quality', bonusHdr: false }), 0);
});
