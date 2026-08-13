// Dimensions video lues DANS le flux, quand personne ne les annonce.
//
// Le cas qui a impose ce fichier : KissKH sert une playlist HLS de segments, sans
// master et donc sans `RESOLUTION=`. Son API n'expose rien non plus. La resolution
// n'est nulle part... sauf a l'endroit ou elle est toujours vraie : l'en-tete SPS du
// flux H.264 lui-meme.
//
// Ce que ca coute : une requete Range de 128 Ko sur le premier segment. Pas de
// telechargement de la video, pas de ffmpeg, pas de dependance. Le resultat ne change
// jamais pour un episode donne, il se met donc en cache longtemps.
//
// Ce que ca rapporte : une resolution MESUREE plutot qu'un « HD » evasif — donc un
// tri par qualite qui veut dire quelque chose, chez nous comme chez AIOStreams, qui
// la lit dans `behaviorHints.filename`.

/** Lecteur de bits, avec desechappement des octets d'emulation (00 00 03). */
class LecteurBits {
  private octets: number[] = [];
  private pos = 0;

  constructor(data: Buffer) {
    // Un flux NAL ne peut pas contenir 00 00 00/01/02/03 : l'encodeur insere un octet
    // 0x03 pour casser ces motifs. Le laisser decalerait toute la lecture.
    for (let i = 0; i < data.length; i++) {
      if (i >= 2 && data[i] === 0x03 && data[i - 1] === 0x00 && data[i - 2] === 0x00) continue;
      this.octets.push(data[i]);
    }
  }

  bit(): number {
    const octet = this.octets[this.pos >> 3];
    if (octet === undefined) throw new Error('fin du flux');
    const v = (octet >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }

  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }

  /** Exp-Golomb non signe, le codage de toute la syntaxe H.264. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 32) throw new Error('exp-golomb aberrant');
    }
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.bits(zeros);
  }

  se(): number {
    const k = this.ue();
    return k % 2 === 0 ? -(k / 2) : (k + 1) / 2;
  }
}

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Dimensions portees par un SPS H.264 (sans son octet d'en-tete NAL).
 *
 * On ne lit que ce qui mene aux dimensions et on s'arrete : le SPS contient bien
 * d'autres champs, mais chacun lu en trop est une occasion de se desynchroniser.
 */
export function dimensionsDepuisSps(sps: Buffer): Dimensions | null {
  try {
    const r = new LecteurBits(sps);
    const profileIdc = r.bits(8);
    r.bits(8); // contraintes + reserve
    r.bits(8); // level_idc
    r.ue(); // seq_parameter_set_id

    // Les profils « High » et au-dela portent ici des champs que les autres n'ont pas.
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      const chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) r.bit(); // separate_colour_plane_flag
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.bit(); // qpprime_y_zero_transform_bypass_flag
      if (r.bit() === 1) {
        // seq_scaling_matrix_present : listes de ponderation a traverser sans les lire.
        const listes = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < listes; i++) {
          if (r.bit() === 1) {
            const taille = i < 6 ? 16 : 64;
            let dernier = 8;
            let suivant = 8;
            for (let j = 0; j < taille; j++) {
              if (suivant !== 0) suivant = (dernier + r.se() + 256) % 256;
              dernier = suivant === 0 ? dernier : suivant;
            }
          }
        }
      }
    }

    r.ue(); // log2_max_frame_num_minus4
    const picOrderCntType = r.ue();
    if (picOrderCntType === 0) {
      r.ue(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      r.bit();
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }

    r.ue(); // max_num_ref_frames
    r.bit(); // gaps_in_frame_num_value_allowed_flag

    const largeurEnMb = r.ue() + 1;
    const hauteurEnMapUnits = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (frameMbsOnly === 0) r.bit(); // mb_adaptive_frame_field_flag
    r.bit(); // direct_8x8_inference_flag

    let cropGauche = 0;
    let cropDroite = 0;
    let cropHaut = 0;
    let cropBas = 0;
    if (r.bit() === 1) {
      cropGauche = r.ue();
      cropDroite = r.ue();
      cropHaut = r.ue();
      cropBas = r.ue();
    }

    // Le rognage s'exprime en unites de chroma : 2 en horizontal, et 2 de plus en
    // vertical quand l'image est entrelacee. Sans ca, un 1080p (rogne de 8 lignes
    // depuis 1088) ressort a 1082 ou 1084.
    const uniteX = 2;
    const uniteY = frameMbsOnly === 1 ? 2 : 4;

    const width = largeurEnMb * 16 - uniteX * (cropGauche + cropDroite);
    const height = (2 - frameMbsOnly) * hauteurEnMapUnits * 16 - uniteY * (cropHaut + cropBas);

    // Plancher de PLAUSIBILITE, pas de validite formelle. Un flux d'octets quelconque
    // se decode souvent en un macrobloc unique (16x16) sans rien violer de la syntaxe :
    // c'est le resultat qu'on obtient sur des donnees aleatoires. Personne ne diffuse
    // en dessous de 160x90, donc en dessous c'est qu'on n'a pas lu un vrai SPS.
    if (width < 160 || height < 90 || width > 16384 || height > 16384) return null;
    return { width, height };
  } catch {
    // SPS tronque par la fenetre de 128 Ko, ou flux qu'on ne sait pas lire : on ne
    // devine pas. L'appelant retombera sur son etiquette generique.
    return null;
  }
}

/** Debut d'un code de depart NAL (00 00 01 ou 00 00 00 01) a partir de `from`. */
function prochainNal(buf: Buffer, from: number): { debut: number; entete: number } | null {
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
    if (buf[i + 2] === 1) return { debut: i + 3, entete: 3 };
    if (buf[i + 2] === 0 && buf[i + 3] === 1) return { debut: i + 4, entete: 4 };
  }
  return null;
}

/**
 * Dimensions lues dans un fragment de flux MPEG-TS.
 *
 * On ne demultiplexe PAS le transport : on ne cherche pas la PMT, on ne suit pas les
 * PID. On extrait les charges utiles des paquets de 188 octets, on les recolle, et on
 * y cherche un SPS. C'est volontairement plus simple qu'un vrai demultiplexeur — un
 * SPS mal identifie donne `null`, ce qui est le meme resultat que ne pas chercher.
 */
export function dimensionsDepuisTs(buf: Buffer): Dimensions | null {
  const TAILLE_PAQUET = 188;
  if (buf.length < TAILLE_PAQUET || buf[0] !== 0x47) return null;

  const morceaux: Buffer[] = [];
  for (let i = 0; i + TAILLE_PAQUET <= buf.length; i += TAILLE_PAQUET) {
    if (buf[i] !== 0x47) break; // synchronisation perdue : on s'arrete la
    const adaptation = (buf[i + 3] >> 4) & 0x3;
    let debut = i + 4;
    if (adaptation === 2) continue; // adaptation seule, aucune charge utile
    if (adaptation === 3) debut += buf[i + 4] + 1;
    if (debut < i + TAILLE_PAQUET) morceaux.push(buf.subarray(debut, i + TAILLE_PAQUET));
  }
  if (morceaux.length === 0) return null;

  const flux = Buffer.concat(morceaux);
  let pos = 0;
  while (pos < flux.length) {
    const nal = prochainNal(flux, pos);
    if (!nal) return null;
    const type = flux[nal.debut] & 0x1f;
    const suivant = prochainNal(flux, nal.debut + 1);
    const fin = suivant ? suivant.debut - suivant.entete : flux.length;
    // 7 = SPS. C'est le seul NAL qui porte les dimensions.
    if (type === 7) {
      const dims = dimensionsDepuisSps(flux.subarray(nal.debut + 1, fin));
      if (dims) return dims;
    }
    pos = nal.debut + 1;
  }
  return null;
}

/**
 * Etiquette de qualite correspondant a des dimensions MESUREES.
 *
 * On ne classe pas sur la hauteur seule : les films au format large sont encodes en
 * 1280x640 ou 1920x800, l'image etant rognee plutot que barree de noir. Sur la hauteur
 * brute, un vrai 720p ressortirait « 576p » et un 1080p cinemascope « 720p » — mesure
 * sur les flux KissKH de « Doctor Climax » et « Squid Game », tous deux en 1280x640.
 *
 * On ramene donc la largeur a la hauteur qu'elle aurait en 16/9 et on garde la plus
 * flatteuse des deux. C'est la lecture qui correspond a ce que les gens appellent
 * « 720p », et a ce qu'un analyseur de noms de release comprend.
 */
export function qualiteDepuis({ width, height }: Dimensions): string {
  const hauteurUtile = Math.max(height, Math.round((width * 9) / 16));
  if (hauteurUtile >= 2000) return '4K';
  if (hauteurUtile >= 1000) return '1080p';
  if (hauteurUtile >= 700) return '720p';
  if (hauteurUtile >= 500) return '576p';
  if (hauteurUtile >= 400) return '480p';
  return '360p';
}

/**
 * Dimensions portees par un conteneur MP4.
 *
 * On ne parcourt pas l'arborescence de boites : on cherche directement le code de
 * l'echantillon video (`avc1`, `hvc1`...), dont l'en-tete porte largeur et hauteur a
 * des positions fixes. Un vrai parcours moov > trak > mdia > minf > stbl > stsd serait
 * plus rigoureux, mais echouerait sur les fichiers dont le `moov` est en fin — alors
 * que la recherche directe trouve ce qu'elle cherche des qu'il est dans la fenetre.
 */
export function dimensionsDepuisMp4(buf: Buffer): Dimensions | null {
  for (const code of ['avc1', 'hvc1', 'hev1', 'av01']) {
    const at = buf.indexOf(code, 0, 'latin1');
    if (at === -1) continue;
    // VisualSampleEntry : taille(4) type(4) reserve(6) index(2) predefini(2) reserve(2)
    // predefini(12) largeur(2) hauteur(2). Le code lu est en tete+4.
    const posLargeur = at + 28;
    if (posLargeur + 4 > buf.length) continue;
    const width = buf.readUInt16BE(posLargeur);
    const height = buf.readUInt16BE(posLargeur + 2);
    if (width >= 160 && height >= 90 && width <= 16384 && height <= 16384) return { width, height };
  }
  return null;
}
