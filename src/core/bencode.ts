// info_hash d'un fichier .torrent, sans decoder le fichier.
//
// Certains trackers prives ne publient pas le hash : ils ne rendent qu'un lien vers le
// .torrent, et c'est a nous de le calculer. C'est le cas de DigitalCore (jamais de
// hash) et de G3mini (parfois).
//
// LA METHODE COMPTE. L'approche repandue — decoder le bencode, ressortir le
// dictionnaire `info`, le RE-ENCODER, puis hacher — a un defaut : elle suppose que le
// re-encodage reproduit exactement les octets d'origine. Un torrent qui s'ecarte de la
// norme (cles non triees, entier ecrit `i-0e`, chaine avec des octets non-UTF8) donne
// alors un hash faux, et le debrideur ne trouvera jamais rien avec.
//
// On ne decode donc rien. On REPERE la plage d'octets du dictionnaire `info` dans le
// fichier tel qu'il est arrive, et on hache cette plage. Ce que le tracker a signe est
// exactement ce qu'on hache.

import { createHash } from 'node:crypto';

/**
 * Fin (exclue) de la valeur bencodee qui commence a `debut`.
 *
 * Scanner, pas analyseur : on ne construit aucune structure, on avance dans les
 * octets. C'est ce qui permet de rester exact sur des fichiers non conformes — on ne
 * juge pas leur contenu, on delimite.
 */
function finDeValeur(buf: Buffer, debut: number): number {
  if (debut >= buf.length) throw new Error('valeur tronquee');
  const c = buf[debut];

  // Entier : i<chiffres>e
  if (c === 0x69) {
    const fin = buf.indexOf(0x65, debut + 1); // 'e'
    if (fin === -1) throw new Error('entier non termine');
    return fin + 1;
  }

  // Liste ou dictionnaire : l...e / d...e, contenu de longueur variable.
  if (c === 0x6c || c === 0x64) {
    let i = debut + 1;
    while (i < buf.length && buf[i] !== 0x65) i = finDeValeur(buf, i);
    if (i >= buf.length) throw new Error('conteneur non termine');
    return i + 1;
  }

  // Chaine : <longueur>:<octets>. La longueur est en decimal ASCII.
  if (c >= 0x30 && c <= 0x39) {
    const sep = buf.indexOf(0x3a, debut); // ':'
    if (sep === -1) throw new Error('chaine sans separateur');
    const longueur = Number(buf.toString('latin1', debut, sep));
    if (!Number.isSafeInteger(longueur) || longueur < 0) throw new Error('longueur aberrante');
    const fin = sep + 1 + longueur;
    if (fin > buf.length) throw new Error('chaine tronquee');
    return fin;
  }

  throw new Error(`octet inattendu 0x${c.toString(16)}`);
}

/**
 * info_hash (SHA-1, minuscules) d'un contenu .torrent, ou `null` si illisible.
 *
 * On cherche la cle `info` AU PREMIER NIVEAU du dictionnaire racine. Chercher la
 * chaine « 4:info » n'importe ou serait faux : elle peut apparaitre dans un nom de
 * fichier ou une liste d'annonceurs, et on hacherait alors la mauvaise plage.
 */
export function infoHashDepuisTorrent(buf: Buffer): string | null {
  try {
    if (buf.length < 4 || buf[0] !== 0x64) return null; // doit commencer par 'd'

    let i = 1;
    while (i < buf.length && buf[i] !== 0x65) {
      // Au premier niveau d'un dictionnaire, chaque entree est une CLE (toujours une
      // chaine) suivie de sa valeur.
      const finCle = finDeValeur(buf, i);
      const sep = buf.indexOf(0x3a, i);
      const cle = buf.toString('latin1', sep + 1, finCle);
      const finValeur = finDeValeur(buf, finCle);

      if (cle === 'info') {
        return createHash('sha1').update(buf.subarray(finCle, finValeur)).digest('hex');
      }
      i = finValeur;
    }
    return null;
  } catch {
    // Fichier tronque, page HTML servie a la place du torrent, contenu chiffre : on
    // rend null. L'appelant ecarte simplement ce resultat.
    return null;
  }
}
