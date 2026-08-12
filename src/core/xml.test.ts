import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBlocks, tagText, attrOf, torznabAttrs, decodeEntities } from './xml';

const RSS = `<?xml version="1.0"?>
<rss><channel>
<item>
  <title><![CDATA[Squid.Game.S01E09.MULTi.1080p.WEB-DL]]></title>
  <size>1610612736</size>
  <enclosure url="magnet:?xt=urn:btih:abc123" type="application/x-bittorrent"/>
  <torznab:attr name="infohash" value="ABC123"/>
  <torznab:attr name="seeders" value="42"/>
</item>
<item>
  <title>Autre &amp; release VOSTFR</title>
  <size>800000000</size>
  <torznab:attr name="seeders" value="7"/>
</item>
</channel></rss>`;

test('extractBlocks isole chaque item', () => {
  const items = extractBlocks(RSS, 'item');
  assert.equal(items.length, 2);
  assert.ok(items[0].includes('Squid.Game'));
});

test('tagText lit le CDATA', () => {
  const items = extractBlocks(RSS, 'item');
  assert.equal(tagText(items[0], 'title'), 'Squid.Game.S01E09.MULTi.1080p.WEB-DL');
  assert.equal(tagText(items[0], 'size'), '1610612736');
});

test('tagText decode les entites', () => {
  const items = extractBlocks(RSS, 'item');
  assert.equal(tagText(items[1], 'title'), 'Autre & release VOSTFR');
});

test('attrOf lit un attribut de balise auto-fermante', () => {
  const items = extractBlocks(RSS, 'item');
  assert.equal(attrOf(items[0], 'enclosure', 'url'), 'magnet:?xt=urn:btih:abc123');
});

test('torznabAttrs rend la carte des attributs', () => {
  const items = extractBlocks(RSS, 'item');
  const attrs = torznabAttrs(items[0]);
  assert.equal(attrs.infohash, 'ABC123');
  assert.equal(attrs.seeders, '42');
});

test('extractBlocks ne confond pas une balise avec son prefixe', () => {
  const xml = '<items><item>vrai</item></items>';
  assert.deepEqual(extractBlocks(xml, 'item'), ['vrai']);
});

test('decodeEntities gere les entites numeriques', () => {
  assert.equal(decodeEntities('S&#233;rie'), 'Série');
});

test('un XML tronque ne fait pas boucler ni planter', () => {
  assert.deepEqual(extractBlocks('<item>jamais ferme', 'item'), []);
  assert.equal(tagText('<title>pas de fin', 'title'), null);
});
