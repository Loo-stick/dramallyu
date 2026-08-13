import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pistes, languesSousTitres, estMatroska, normaliserLangue } from './mkv';

/** Construit un element EBML : identifiant brut + taille sur un octet + donnees. */
function el(id: number[], data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | data.length]), data]);
}
const chaine = (s: string) => Buffer.from(s, 'latin1');
const entier = (n: number) => Buffer.from([n]);

/** TrackEntry minimal : type, codec, langue. */
function piste(type: number, codec: string, langue?: string): Buffer {
  const champs = [el([0x83], entier(type)), el([0x86], chaine(codec))];
  if (langue) champs.push(el([0x22, 0xb5, 0x9c], chaine(langue)));
  return el([0xae], Buffer.concat(champs));
}

function fichier(...entrees: Buffer[]): Buffer {
  const tracks = el([0x16, 0x54, 0xae, 0x6b], Buffer.concat(entrees));
  const segment = el([0x18, 0x53, 0x80, 0x67], tracks);
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0, 0, 0, 0]), segment]);
}

test('les pistes sont lues avec leur VRAIE langue', () => {
  // Le point de tout ce fichier : une premiere version cherchait la declaration de
  // langue la plus PROCHE du codec, et attribuait a un sous-titre la langue d'une
  // piste audio voisine. Ici, l'audio est coreen et le sous-titre francais.
  const buf = fichier(
    piste(1, 'V_MPEG4/ISO/AVC'),
    piste(2, 'A_EAC3', 'kor'),
    piste(17, 'S_TEXT/UTF8', 'fre'),
    piste(17, 'S_TEXT/UTF8', 'chi'),
  );
  assert.equal(estMatroska(buf), true);
  assert.deepEqual(languesSousTitres(buf), ['fre', 'chi']);
  assert.equal(pistes(buf).filter((p) => p.type === 2)[0].langue, 'kor');
});

test('une piste sans langue declaree vaut « eng »', () => {
  // Regle imposee par Matroska : les fichiers anglophones n'ecrivent souvent rien.
  assert.deepEqual(languesSousTitres(fichier(piste(17, 'S_TEXT/UTF8'))), ['eng']);
});

test('les codes equivalents sont ramenes a une seule forme', () => {
  // fre/fra, chi/zho : les deux codes ISO 639-2 du francais et du chinois circulent.
  assert.equal(normaliserLangue('fra'), 'fre');
  assert.equal(normaliserLangue('fr-FR'), 'fre');
  assert.equal(normaliserLangue('zho'), 'chi');
});

test('ce qui n est pas un Matroska ne rend rien', () => {
  assert.equal(estMatroska(Buffer.from('ftypmp42', 'latin1')), false);
  assert.deepEqual(pistes(Buffer.from('ftypmp42', 'latin1')), []);
});

test('un en-tete tronque rend un tableau vide, pas une conclusion', () => {
  // Tableau vide signifie « on n a pas su lire », JAMAIS « aucun sous-titre » : c est
  // l appelant qui doit faire la difference.
  const complet = fichier(piste(17, 'S_TEXT/UTF8', 'fre'));
  assert.deepEqual(pistes(complet.subarray(0, 12)), []);
});
