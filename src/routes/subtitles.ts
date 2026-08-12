// Ressource /subtitles + endpoint de service des pistes.
//
// POURQUOI UNE RESSOURCE ET PAS DES SUBS SUR LE STREAM : Nuvio IGNORE purement et
// simplement le champ `subtitles` d'un objet Stream (verifie sur HLS comme sur MP4).
// La ressource est le seul mecanisme qui marche sur les deux clients. Corollaire :
// on ne met JAMAIS aussi les sous-titres au niveau du stream, sinon Nuvio empile les
// pistes en double.
//
// Deux autres regles imposees par les clients :
//   - codes langue en ISO 639-2 (fre/eng), pas en ISO 639-1 (fr/en) ;
//   - les URLs pointent vers NOS endpoints, qui servent du text/vtt — un lien direct
//     vers l'hebergeur d'origine ne s'affiche pas (CORS, format, en-tetes).

import type { Request, Response } from 'express';
import { parseConfig } from '../core/config';
import { parseStremioId } from '../core/ids';
import { resolveWork } from '../core/meta';
import { subtitlesAll } from '../core/registry';
import { findSubtitles } from '../subs/opensubtitles';
import { toVtt } from '../subs/convert';
import { estChiffre, dechiffrerVtt } from '../sources/direct/kisskh/subdecrypt';
import { getBaseUrl } from '../core/url';
import { encodeToken, decodeToken } from '../debrid/token';
import { httpGet } from '../core/http';
import type { MediaType, SubTrack } from '../sources/types';

/** Un jeton signe par piste : l'endpoint /sub ne doit pas devenir un proxy ouvert. */
function subUrl(base: string, track: SubTrack): string {
  const token = encodeToken({ k: 'ddl', v: track.url });
  return `${base}/sub/${token}.vtt`;
}

export async function handleSubtitles(req: Request, res: Response): Promise<void> {
  const config = parseConfig((req.params as Record<string, string>).config);
  const type: MediaType = req.params.type === 'movie' ? 'movie' : 'series';
  const parsed = parseStremioId(req.params.id);
  if (!parsed) {
    res.json({ subtitles: [] });
    return;
  }

  try {
    const work = await resolveWork(parsed, type, config);
    if (!work) {
      res.json({ subtitles: [] });
      return;
    }

    const query = {
      type,
      imdbId: work.imdbId,
      tmdbId: work.tmdbId,
      kkhId: work.kkhId,
      titles: work.titles,
      year: work.year,
      season: parsed.season,
      episode: parsed.episode,
      originalLanguage: work.originalLanguage,
    };

    // Les sources d'abord (KissKH porte de vraies pistes synchronisees avec SON flux),
    // OpenSubtitles ensuite en complement pour les langues manquantes.
    const fromSources = await subtitlesAll(query, config);
    const missing = config.subLangs.filter((l) => !fromSources.some((t) => t.lang === l));
    const external = (
      await Promise.all(
        missing.map((lang) =>
          findSubtitles(work.imdbId, lang, parsed.season, parsed.episode).catch(() => []),
        ),
      )
    ).flat();

    const base = getBaseUrl(req);
    const seen = new Set<string>();
    const subtitles = [...fromSources, ...external]
      .filter((t) => {
        if (seen.has(t.url)) return false;
        seen.add(t.url);
        return true;
      })
      .map((t, i) => ({
        id: `dramallyu-${i}`,
        url: subUrl(base, t),
        lang: t.lang,
      }));

    res.json({ subtitles });
  } catch (e) {
    console.error(`[Subtitles] echec ${req.params.id}: ${(e as Error).message}`);
    res.json({ subtitles: [] });
  }
}

const MAX_SUB_BYTES = 4 * 1024 * 1024;

/** Sert une piste convertie en VTT. Le jeton signe evite le proxy ouvert. */
export async function handleServeSub(req: Request, res: Response): Promise<void> {
  const raw = String(req.params.token || '').replace(/\.vtt$/i, '');
  const payload = decodeToken(raw);
  if (!payload) {
    res.status(403).type('text/plain').send('jeton invalide ou expire');
    return;
  }

  // En binaire : OpenSubtitles sert des .srt.gz, qu'un decodage texte detruirait
  // avant meme qu'on puisse les decompresser.
  const response = await httpGet<ArrayBuffer>(payload.v, {
    timeoutMs: 15000,
    responseType: 'buffer',
    maxBytes: MAX_SUB_BYTES,
    retries: 1,
  });
  if (!response || response.status < 200 || response.status >= 300) {
    res.status(502).type('text/plain').send('sous-titre injoignable');
    return;
  }

  const buf = Buffer.isBuffer(response.data)
    ? (response.data as Buffer)
    : Buffer.from(response.data as ArrayBuffer);
  const vtt = toVtt(buf);
  if (!vtt) {
    res.status(415).type('text/plain').send('format de sous-titre non pris en charge');
    return;
  }

  // Pistes KissKH chiffrees : le FICHIER est structurellement valide, seules les
  // repliques sont brouillees. On tente le dechiffrement, et on refuse de servir si
  // le resultat n'est pas credible — du charabia par-dessus la video serait pire que
  // pas de sous-titres du tout.
  let corps = vtt;
  if (estChiffre(payload.v)) {
    const clair = await dechiffrerVtt(vtt, payload.v);
    if (!clair) {
      res.status(415).type('text/plain').send('piste chiffree non dechiffrable');
      return;
    }
    corps = clair;
  }

  res.set('Content-Type', 'text/vtt; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(corps);
}
