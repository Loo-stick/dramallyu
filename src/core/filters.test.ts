import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passeFiltres, comparer, estCam, contientFormat, rangResolution, rangSource, tailleJugee, porteDuFrancais } from './filters';
import type { Filtres, EtatFlux, OptionsTri } from './filters';
import { languageOf } from '../sources/torrent/release';
import type { Candidate } from '../sources/types';

const NEUTRE: Filtres = {
  cachedOnly: false,
  // Par defaut la verification a eu lieu : c'est le cas courant, et cela laisse les
  // autres tests juger le filtre lui-meme plutot que son garde-fou.
  verificationFaite: true,
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
  const f = { ...NEUTRE, cachedOnly: true, verificationFaite: true };
  assert.equal(passeFiltres(flux({}, true), f), true);
  assert.equal(passeFiltres(flux({}, false), f), false);
  // Invérifiable (lien DDL sans hash) : ecarte aussi, mais ce n'est pas la meme
  // chose — l'utilisateur a demande « seulement ce qui est sur ».
  assert.equal(passeFiltres(flux({}, undefined), f), false);
});

test('« seulement le cache » NE S APPLIQUE PAS si la verification n a pas eu lieu', () => {
  // A froid, le fan-out consomme le budget et la verification de disponibilite est
  // sautee ou expire. Elle rendait une carte vide, lue comme « rien n'est pret » : la
  // liste entiere disparaissait, puis tout revenait au rechargement. Deux requetes
  // simultanees et identiques rendaient 0 et 3 flux — c'est ce qui a mis sur la piste.
  //
  // On ne coupe jamais sur une information qu'on n'a pas : mieux vaut une liste sans
  // etiquette « pret » qu'une liste vide.
  const f = { ...NEUTRE, cachedOnly: true, verificationFaite: false };
  assert.equal(passeFiltres(flux({}, undefined), f), true);
  assert.equal(passeFiltres(flux({}, false), f), true);
  assert.equal(passeFiltres(flux({}, true), f), true);
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

test('un flux direct est PRET au tri, comme un fichier en cache', () => {
  // Symetrique du filtre : `passeFiltres` laisse deja passer le direct sous
  // « uniquement ce qui est pret », et l'addon lui affiche `[▶ ⚡]`. Le compter comme
  // « pas pret » au tri faisait passer tout torrent en cache devant KissKH.
  // A qualite et langue egales, seul l'etat de pret peut les departager : le direct
  // ne doit pas perdre sur ce critere-la. (Un torrent 4K en cache peut evidemment
  // repasser devant sur un tri par qualite — c'est le tri qui parle, pas le « pret ».)
  const direct = flux({ kind: 'direct', sourceId: 'kisskh' }, undefined);
  const torrentPret = flux({ kind: 'torrent' }, true);
  assert.equal(comparer(direct, torrentPret, TRI), 0, 'egalite : aucun n est relegue');
  const torrentPasPret = flux({ kind: 'torrent' }, false);
  assert.ok(comparer(direct, torrentPasPret, TRI) < 0, 'le direct precede ce qui reste a debrider');
});

test('KissKH mene parmi les sources directes', () => {
  const kk = flux({ kind: 'direct', sourceId: 'kisskh', quality: '720p' }, undefined);
  const vd = flux({ kind: 'direct', sourceId: 'voirdrama', quality: '1080p' }, undefined);
  // Meme avec une qualite annoncee moindre, et quel que soit le critere de tri.
  assert.ok(comparer(kk, vd, { ...TRI, sortBy: 'quality' }) < 0);
  assert.ok(comparer(kk, vd, { ...TRI, sortBy: 'size' }) < 0);
});

test('avec la priorite « direct », KissKH est en tete de toute la liste', () => {
  const liste = [
    flux({ kind: 'torrent', quality: '4K', language: 'VOSTFR' }, true),
    flux({ kind: 'direct', sourceId: 'voirdrama', quality: '1080p' }, undefined),
    flux({ kind: 'ddl', quality: '1080p' }, undefined),
    flux({ kind: 'direct', sourceId: 'kisskh', quality: 'HD' }, undefined),
  ];
  const trie = [...liste].sort((a, b) => comparer(a, b, { ...TRI, priorite: 'direct' }));
  assert.equal(trie[0].candidate.sourceId, 'kisskh');
});

test('un pack est juge au poids d UN episode, pas du dossier', () => {
  // Vecu : « Squid Game S01 » (23 Go, 9 episodes) etait supprime par un plafond de
  // 10 Go, alors que l'episode qu'on en tire pese 2,6 Go. Le debrideur n'ouvre que ce
  // fichier — les huit autres ne sont jamais telecharges. Le plafond visait donc
  // quelque chose que l'utilisateur ne lit jamais, et faisait perdre des sources
  // entieres (DarkPeers ne publie QUE des packs).
  const pack = flux({ title: 'Squid.Game.S01.1080p.NF.WEB-DL.x264-TEAM', sizeBytes: 23 * 1024 ** 3 });
  const f = { ...NEUTRE, maxSizeGb: 10 };
  assert.equal(passeFiltres(pack, f), false, 'sans le compte, le poids brut fait foi');
  assert.equal(passeFiltres(pack, { ...f, episodesSaison: 9 }), true, '23 Go / 9 = 2,6 Go');
  assert.equal(tailleJugee(pack.candidate, 9) / 1024 ** 3 < 3, true);
});

test('un episode unitaire reste juge sur son propre poids', () => {
  const episode = flux({ title: 'Squid.Game.S01E01.1080p.WEB-DL.x264', sizeBytes: 12 * 1024 ** 3 });
  assert.equal(passeFiltres(episode, { ...NEUTRE, maxSizeGb: 10, episodesSaison: 9 }), false);
  assert.equal(tailleJugee(episode.candidate, 9), 12 * 1024 ** 3, 'aucune division sur un episode');
});

test('un compte d episodes absurde ne divise pas', () => {
  // Une saison a 1 episode, ou un compte manquant, doit laisser le poids brut : diviser
  // par 1 ne change rien, et diviser par 0 rendrait tout acceptable.
  const pack = flux({ title: 'Drama.S01.COMPLETE.1080p', sizeBytes: 40 * 1024 ** 3 });
  assert.equal(tailleJugee(pack.candidate, 1), 40 * 1024 ** 3);
  assert.equal(tailleJugee(pack.candidate, undefined), 40 * 1024 ** 3);
});

test('« Multi Subs » n est PAS une promesse de francais', () => {
  // Vecu : « Pursuit of Jade S01 ... x264-Tsundere-Raws (Multi Subs, Multi Audio) »
  // etait etiquete MULTI, donc presente comme porteur de francais. Le fichier livre
  // contient 13 pistes integrees — en chinois et en anglais. Promettre une langue
  // absente est la pire erreur possible ici.
  const nom = 'Pursuit of Jade S01 1080p NF WEB-DL x264-Tsundere-Raws (Multi Subs, Multi Audio)';
  // On passe par `languageOf`, comme le fait la source : c'est lui qu'on corrige.
  assert.equal(languageOf(nom), 'VO');
  // SOURCE EXPLICITE : le cas vecu venait de DarkPeers et DigitalCore, deux trackers
  // INTERNATIONAUX. Le defaut du fabricant est `c411`, dont l'origine francophone vaut
  // desormais preuve a elle seule — laisser le defaut faisait porter ce test sur autre
  // chose que ce qu'il decrit.
  assert.equal(
    porteDuFrancais(flux({ sourceId: 'dpeers', title: nom, language: languageOf(nom) }).candidate),
    false,
  );

  // Le jeton « MULTi » seul reste la convention de scene francaise.
  const scene = flux({ title: 'Squid.Game.S01.MULTi.1080p.WEBRiP.x265-R3MiX.FRENCH', language: 'MULTI' });
  assert.equal(porteDuFrancais(scene.candidate), true);
});

test('« ecarter ce qui n a pas de francais » laisse passer l inconnu', () => {
  // L'etiquette du titre ne suffit ni a garder ni a ecarter : elle ne dit rien des
  // pistes reellement presentes. Un « VO » peut porter du francais integre, et c'est
  // arrive. On ne coupe donc que sur du connu.
  const f = { ...NEUTRE, frOnly: true };
  assert.equal(passeFiltres(flux({ language: 'VOSTFR' }), f), true);
  assert.equal(passeFiltres(flux({ language: 'VF' }), f), true);
  assert.equal(passeFiltres(flux({ language: 'VO', title: 'Drama.S01E01.1080p.WEB-DL' }), f), true);
});

test('une source directe qui PORTE une piste FR passe, meme titre muet', () => {
  // La difference de certitude est le point : sur une source directe on a enumere les
  // pistes, on ne suppose pas.
  const direct = flux({
    kind: 'direct', sourceId: 'kisskh', title: 'Pursuit of Jade - Chasing Jade',
    language: 'VO', subs: [{ lang: 'fre', url: 'http://x/1.vtt' }, { lang: 'eng', url: 'http://x/2.vtt' }],
  } as never);
  assert.equal(passeFiltres(direct, { ...NEUTRE, frOnly: true }), true);
});

test('« ecarter ce qui n a pas de francais » n ecarte que le CERTAIN', () => {
  // Vecu sur « Pursuit of Jade » : le meme fichier passait chez DarkPeers, qui publie
  // son MediaInfo, et disparaissait chez DigitalCore, qui n'en publie pas. Couper sur
  // l'ignorance faisait perdre une release parfaitement francaise.
  const f = { ...NEUTRE, frOnly: true };

  const lu = flux({ languesIntegrees: ['chi', 'eng'] } as never);
  assert.equal(passeFiltres(lu, f), false, 'pistes lues, pas de FR -> on sait');

  const luAvecFr = flux({ languesIntegrees: ['fre', 'eng'] } as never);
  assert.equal(passeFiltres(luAvecFr, f), true);

  const inconnu = flux({ title: 'Pursuit.of.Jade.S01.1080p.IQIYI.WEB-DL-ANDY', language: 'VO' });
  assert.equal(passeFiltres(inconnu, f), true, 'rien de connu -> on garde');
});
