import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFn,
  seasonEpisodeFromFilename,
  parseSearchResults,
  parseFicheLinks,
  looksParked,
  estLecteurStreaming,
  parseTaille,
  gateTarget,
} from './wawacity';

// Formes reelles relevees sur wawacity.estate le 2026-08-13.
const FN_EP1 = Buffer.from('Squid Game - Saison 1 Épisode 1 - [VF HD]', 'utf-8').toString('base64');
const FN_EP3 = Buffer.from('Squid Game - Saison 1 Épisode 3 - [VOSTFR 1080p]', 'utf-8').toString('base64');
const FN_SERVICE = Buffer.from('series|12748|1', 'utf-8').toString('base64');

test('decode le nom de fichier porte par le parametre fn', () => {
  assert.equal(
    decodeFn(`https://dl-protect.link/abc?fn=${FN_EP1}`),
    'Squid Game - Saison 1 Épisode 1 - [VF HD]',
  );
});

test('ecarte les liens de service (charge technique, pas un fichier)', () => {
  // « series|12748|1 » n'est pas un nom de fichier : le retenir creerait un faux flux.
  assert.equal(decodeFn(`https://dl-protect.link/rqts-url?fn=${FN_SERVICE}`), null);
});

test('un lien sans parametre fn rend null', () => {
  assert.equal(decodeFn('https://dl-protect.link/abc'), null);
});

test('lit la saison et l episode dans un nom de fichier francais accentue', () => {
  assert.deepEqual(seasonEpisodeFromFilename('Squid Game - Saison 1 Épisode 3 - [VF HD]'), {
    season: 1,
    episode: 3,
  });
  assert.deepEqual(seasonEpisodeFromFilename('Drama - Saison 12 Episode 07'), {
    season: 12,
    episode: 7,
  });
});

test('un nom de film ne porte ni saison ni episode', () => {
  assert.deepEqual(seasonEpisodeFromFilename('Old Boy - [MULTI 1080p]'), {
    season: null,
    episode: null,
  });
});

test('extrait les fiches d une page de resultats', () => {
  const html = `
    <a href="?p=serie&amp;id=12748-squid-game-saison1">S1</a>
    <a href="?p=serie&amp;id=23831-squid-game-saison2">S2</a>
    <a href="?p=films&amp;search=squid&amp;genre=action">filtre</a>
    <a href="?p=serie&amp;id=12748-squid-game-saison1">doublon</a>`;
  const res = parseSearchResults(html);
  assert.equal(res.length, 2, 'les filtres de genre et les doublons sont ecartes');
  assert.ok(res[0].includes('12748-squid-game-saison1'));
  assert.ok(!res[0].includes('&amp;'), 'les entites doivent etre decodees');
});

/** Forme reelle d'une ligne de lien : l'hebergeur et la taille sont des cellules voisines. */
function ligne(fn: string, hebergeur: string, taille: string): string {
  return `<tr class="link-row">
    <td><a href="https://dl-protect.link/${hebergeur}?fn=${fn}&amp;rl=b1" class="link">Lien 1: Telecharger</a></td>
    <td class="text-center" width="120px">${hebergeur}</td>
    <td class="text-center" width="80px">${taille}</td>
  </tr>`;
}

test('extrait les liens avec hebergeur et taille', () => {
  const html = ligne(FN_EP1, '1fichier', '2 Go') + ligne(FN_EP3, 'Uptobox', '1.4 Go');
  const liens = parseFicheLinks(html);
  assert.equal(liens.length, 2);
  assert.equal(liens[0].episode, 1);
  assert.equal(liens[0].hebergeur, '1fichier');
  assert.equal(liens[0].sizeBytes, 2 * 1024 ** 3);
  assert.equal(liens[1].episode, 3);
  assert.equal(liens[1].season, 1);
});

test('les liens de service sont ecartes', () => {
  assert.equal(parseFicheLinks(ligne(FN_SERVICE, 'Anonyme', '2 Go')).length, 0);
});

test('les lignes commentees ne comptent pas', () => {
  // Le site laisse des offres publicitaires desactivees en commentaire HTML.
  const html = `<!-- ${ligne(FN_EP1, '1fichier', '2 Go')} -->` + ligne(FN_EP3, 'Uptobox', '1 Go');
  const liens = parseFicheLinks(html);
  assert.equal(liens.length, 1);
  assert.equal(liens[0].hebergeur, 'Uptobox');
});

test('les lecteurs de streaming sont reconnus comme tels', () => {
  // On ECARTE ces noms-la ; la liste de ce qu'on GARDE vient des debrideurs
  // eux-memes (debrid/hosts.ts), pas d'une liste ecrite a la main.
  assert.equal(estLecteurStreaming('Vidlox'), true);
  assert.equal(estLecteurStreaming('Dood'), true);
  assert.equal(estLecteurStreaming('Anonyme'), true);
  assert.equal(estLecteurStreaming('1fichier'), false);
  assert.equal(estLecteurStreaming('Rapidgator'), false);
});

test('taille lue en unites francaises et anglaises', () => {
  assert.equal(parseTaille('2 Go'), 2 * 1024 ** 3);
  assert.equal(parseTaille('1.4 GB'), Math.round(1.4 * 1024 ** 3));
  assert.equal(parseTaille('700 Mo'), 700 * 1024 ** 2);
  assert.equal(parseTaille('n importe quoi'), undefined);
});

test('reconnait un domaine parque', () => {
  assert.equal(looksParked('<script>var x="/sk-park.php?pid=9PO"</script>'), true);
  assert.equal(looksParked('<script id="cfg">{"mode":"iframe","domain":"x"}</script>'), true);
  assert.equal(looksParked('<html><body>Wawacity - Site de Telechargement</body></html>'), false);
});

test('construit la cible du portillon avec le repli sans JavaScript', () => {
  assert.equal(
    gateTarget("var redirect_link = 'http://x.tld/?p=series&tr_uuid=abc&';"),
    'http://x.tld/?p=series&tr_uuid=abc&fp=-5',
  );
  assert.equal(gateTarget('aucun portillon ici'), null);
});
