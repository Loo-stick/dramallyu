// Source KissKH : le pilier « direct ».
//
// Interet strategique : elle ne demande AUCUNE cle. Un utilisateur qui installe
// l'addon sans rien configurer a deja des flux et des sous-titres. C'est ce qui rend
// l'addon adoptable par une communaute, la ou un agregateur torrent pur exige un
// abonnement debrid avant de servir quoi que ce soit.

import type { Candidate, Query, SearchContext, Source, SubTrack } from '../../types';
import { drama, episodeSubs, episodeVideo, search, type KkDrama, type KkSearchItem } from './client';
import { bestMatch, seasonInTitle } from '../../../core/matching';
import { normalizeLangCode } from '../../../core/config';
import { getText, BROWSER_HEADERS } from '../../../core/http';
import { cached } from '../../../core/cache';
import { dimensionsDepuisTs, qualiteDepuis, type Dimensions } from '../../../core/h264';

export const SOURCE_ID = 'kisskh';

/** Un episode KissKH resolu : la fiche et l'episode precis. */
interface Resolved {
  drama: KkDrama;
  episodeId: number;
}

/**
 * Retrouve la fiche KissKH correspondant a la demande.
 *
 * KissKH eclate les saisons en fiches distinctes (« Squid Game Season 1 », « Squid
 * Game Season 2 »). On cherche donc le titre nu, puis on retient la fiche dont la
 * saison annoncee correspond — une fiche sans saison explicite valant saison 1.
 */
async function findDrama(q: Query, signal?: AbortSignal): Promise<KkDrama | null> {
  if (q.kkhId) return drama(q.kkhId, signal);

  const wantedSeason = q.type === 'series' ? (q.season ?? 1) : undefined;

  for (const title of q.titles) {
    if (!title) continue;
    const results = await search(title, signal);
    if (results.length === 0) continue;

    const candidates =
      wantedSeason === undefined
        ? results
        : results.filter((r) => (seasonInTitle(r.title) ?? 1) === wantedSeason);

    const picked = bestMatch<KkSearchItem>(
      candidates.length > 0 ? candidates : results,
      (r) => r.title,
      q.titles,
      { year: q.year, threshold: 0.75 },
    );
    if (picked) {
      const full = await drama(picked.id, signal);
      if (full) return full;
    }
  }
  return null;
}

async function resolveEpisode(q: Query, signal?: AbortSignal): Promise<Resolved | null> {
  const d = await findDrama(q, signal);
  if (!d || d.episodes.length === 0) return null;

  if (q.type === 'movie') {
    // Un film n'a qu'un « episode » chez KissKH.
    return { drama: d, episodeId: d.episodes[0].id };
  }

  const wanted = q.episode ?? 1;
  const ep = d.episodes.find((e) => e.number === wanted);
  // Servir un autre episode que celui demande est pire que ne rien servir.
  if (!ep) return null;
  return { drama: d, episodeId: ep.id };
}

/**
 * Vraie resolution du flux HLS, quand le budget le permet.
 *
 * La master playlist est minuscule et porte les RESOLUTION= des variantes. Sans ca on
 * afficherait « HD » a l'aveugle, et le tri par qualite ne voudrait rien dire. Le
 * garde-fou est le budget : si le fan-out est deja serre, on n'engage pas cette
 * requete et on assume l'etiquette generique.
 */
async function probeQuality(hlsUrl: string, ctx: SearchContext): Promise<string> {
  if (ctx.deadline.remainingMs() < 3500) return 'HD';
  const body = await cached<string | null>(
    `kisskh:hlsq:${hlsUrl}`,
    30 * 60 * 1000,
    () => getText(hlsUrl, { timeoutMs: 3000, signal: ctx.deadline.signal, retries: 0, maxBytes: 256 * 1024 }),
    { scope: 'kisskh', shouldCache: (v) => v !== null, negativeTtlMs: 5 * 60 * 1000 },
  );
  if (!body) return 'HD';

  let best = 0;
  for (const m of body.matchAll(/RESOLUTION=(\d{2,5})x(\d{2,5})/g)) {
    const height = Number(m[2]);
    if (height > best) best = height;
  }
  if (best > 0) return qualiteDepuis({ width: Math.round((best * 16) / 9), height: best });

  // Aucune variante annoncee : c'est le cas de KissKH, dont la playlist ne liste que
  // des segments. On lit alors la resolution DANS le flux (cf. core/h264.ts).
  return (await mesurerDansLeFlux(body, ctx)) ?? 'HD';
}

/**
 * Resolution lue dans le premier segment, quand la playlist ne l'annonce pas.
 *
 * Une requete Range de 128 Ko suffit a atteindre le SPS : ni telechargement de la
 * video, ni ffmpeg. Le resultat est vrai pour toujours sur un episode donne — d'ou un
 * cache de 24 h, la ou la playlist elle-meme n'est gardee que 30 min (ses URL signees
 * expirent, pas les dimensions de l'image).
 */
async function mesurerDansLeFlux(playlist: string, ctx: SearchContext): Promise<string | null> {
  const segment = playlist.split('\n').find((l) => l.startsWith('http'))?.trim();
  if (!segment) return null;

  // Cle stable : les URL de segment portent un jeton qui change a chaque resolution.
  // Sans ce nettoyage, chaque requete creerait une entree de cache neuve et on
  // retelechargerait 128 Ko a chaque fois — exactement ce qu'on cherche a eviter.
  const cle = segment.split('?')[0];

  const dims = await cached<Dimensions | null>(
    `kisskh:dims:${cle}`,
    24 * 60 * 60 * 1000,
    async () => {
      if (ctx.deadline.remainingMs() < 2500) return null;
      try {
        const res = await fetch(segment, {
          headers: { ...BROWSER_HEADERS, Range: 'bytes=0-131071' },
          signal: ctx.deadline.signal,
        });
        if (!res.ok) return null;
        return dimensionsDepuisTs(Buffer.from(await res.arrayBuffer()));
      } catch {
        return null;
      }
    },
    { scope: 'kisskh', shouldCache: (v) => v !== null, negativeTtlMs: 30 * 60 * 1000 },
  );

  return dims ? qualiteDepuis(dims) : null;
}

/** Pistes de sous-titres KissKH, converties en ISO 639-2 et FR en tete. */
function toSubTracks(subs: { src: string; label: string; land: string }[], subLangs: string[]): SubTrack[] {
  const tracks = subs
    .filter((s) => s.src)
    .map((s) => ({
      url: s.src,
      lang: normalizeLangCode(s.land || 'und'),
      label: s.label || s.land || 'Sous-titres',
    }));

  // Ordre de preference de l'utilisateur d'abord, le reste ensuite : on ne jette
  // aucune langue (l'utilisateur peut vouloir du coreen), on les classe.
  const rank = (lang: string): number => {
    const i = subLangs.indexOf(lang);
    return i === -1 ? 100 : i;
  };
  return tracks.sort((a, b) => rank(a.lang) - rank(b.lang));
}

async function searchKisskh(q: Query, ctx: SearchContext): Promise<Candidate[]> {
  const signal = ctx.deadline.signal;
  const resolved = await resolveEpisode(q, signal);
  if (!resolved) return [];

  const [video, subs] = await Promise.all([
    episodeVideo(resolved.episodeId, signal),
    episodeSubs(resolved.episodeId, signal),
  ]);
  if (!video?.Video) return [];

  const tracks = toSubTracks(subs, ctx.config.subLangs);
  const hasFrench = tracks.some((t) => t.lang === 'fre');
  const quality = await probeQuality(video.Video, ctx);

  return [
    {
      sourceId: SOURCE_ID,
      kind: 'direct',
      title: resolved.drama.title,
      quality,
      // L'audio est toujours en version originale chez KissKH. On n'annonce VOSTFR
      // que si une piste FR existe reellement pour cet episode — annoncer du VOSTFR
      // sans sous-titre francais serait un mensonge que l'utilisateur decouvre en
      // lançant la lecture.
      language: hasFrench ? 'VOSTFR' : 'VO',
      directUrl: video.Video,
      headers: { Referer: 'https://kisskh.co/' },
      subs: tracks,
    },
  ];
}

async function subtitlesKisskh(q: Query, ctx: SearchContext): Promise<SubTrack[]> {
  const resolved = await resolveEpisode(q, ctx.deadline.signal);
  if (!resolved) return [];
  const subs = await episodeSubs(resolved.episodeId, ctx.deadline.signal);
  return toSubTracks(subs, ctx.config.subLangs);
}

export const kisskhSource: Source = {
  id: SOURCE_ID,
  label: 'KissKH',
  kind: 'direct',
  needsDebrid: false,
  search: searchKisskh,
  subtitles: subtitlesKisskh,
};
