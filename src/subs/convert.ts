// Conversion des sous-titres vers WebVTT.
//
// Stremio et Nuvio veulent du VTT servi par NOUS, en text/vtt. Les sources livrent du
// SRT (le plus courant), de l'ASS/SSA (les teams de fansub asiatiques y tiennent, pour
// le positionnement et les karaokes) et parfois du VTT deja pret.

import * as zlib from 'node:zlib';

/** Decompresse si besoin : OpenSubtitles legacy sert du SRT gzippe. */
export function maybeGunzip(buf: Buffer): Buffer {
  // En-tete gzip : 0x1f 0x8b.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf);
    } catch {
      return buf;
    }
  }
  return buf;
}

/**
 * Decode en texte. Les sous-titres asiatiques arrivent souvent en UTF-8 avec BOM, et
 * parfois en latin-1 pour les vieux fichiers FR : on retire le BOM et on retombe sur
 * latin1 quand l'UTF-8 produit trop de caracteres de remplacement.
 */
export function decodeText(buf: Buffer): string {
  let text = buf.toString('utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const replacements = (text.match(/�/g) || []).length;
  if (replacements > 0 && replacements / Math.max(1, text.length) > 0.002) {
    return buf.toString('latin1');
  }
  return text;
}

function normalizeTimestamp(ts: string): string {
  // SRT : 00:01:02,500 -> VTT : 00:01:02.500
  return ts.replace(',', '.');
}

export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, (_m, a, b) => `${a}.${b}`);
  return `WEBVTT\n\n${body.trim()}\n`;
}

/** Centiemes ASS (0:00:01.50) -> millisemes VTT (00:00:01.500). */
function assTimeToVtt(t: string): string {
  const m = t.trim().match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return '00:00:00.000';
  const h = m[1].padStart(2, '0');
  const cs = m[4].padEnd(3, '0');
  return `${h}:${m[2]}:${m[3]}.${cs}`;
}

export function assToVtt(ass: string): string {
  const lines = ass.replace(/\r\n/g, '\n').split('\n');
  const cues: string[] = [];

  // Le format ASS declare l'ordre de ses colonnes dans une ligne « Format: ».
  // Le lire plutot que de supposer un ordre fixe evite de sortir du charabia sur les
  // fichiers qui rangent Text ailleurs qu'en derniere position.
  let idxStart = 1;
  let idxEnd = 2;
  let idxText = 9;

  for (const line of lines) {
    if (line.startsWith('Format:') && idxText === 9) {
      const cols = line
        .slice(7)
        .split(',')
        .map((c) => c.trim().toLowerCase());
      if (cols.includes('start')) idxStart = cols.indexOf('start');
      if (cols.includes('end')) idxEnd = cols.indexOf('end');
      if (cols.includes('text')) idxText = cols.indexOf('text');
      continue;
    }
    if (!line.startsWith('Dialogue:')) continue;

    const parts = line.slice(9).split(',');
    if (parts.length <= idxText) continue;
    const start = assTimeToVtt(parts[idxStart]);
    const end = assTimeToVtt(parts[idxEnd]);
    const text = parts
      .slice(idxText)
      .join(',')
      // Balises de style ASS ({\an8}, {\i1}...) : illisibles telles quelles en VTT.
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\h/gi, ' ')
      .trim();
    if (!text) continue;
    cues.push(`${start} --> ${end}\n${text}`);
  }

  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export type SubFormat = 'vtt' | 'srt' | 'ass' | 'inconnu';

/** Reconnait le format au CONTENU, jamais a l'extension : les sources mentent. */
export function detectFormat(text: string): SubFormat {
  const head = text.slice(0, 4000);
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (head.includes('[Script Info]') || head.includes('Dialogue:')) return 'ass';
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(head)) return 'srt';
  return 'inconnu';
}

/**
 * Conversion generique. Renvoie null si le contenu n'est pas un sous-titre lisible —
 * ce qui arrive avec les pistes CHIFFREES de KissKH (extensions .txt / .txt1, cf.
 * docs/kkey.md) : mieux vaut ne rien servir que du charabia dans le lecteur.
 */
export function toVtt(buf: Buffer): string | null {
  const text = decodeText(maybeGunzip(buf));
  switch (detectFormat(text)) {
    case 'vtt':
      return text;
    case 'srt':
      return srtToVtt(text);
    case 'ass':
      return assToVtt(text);
    default:
      return null;
  }
}
