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
import { getText } from '../../../core/http';
import { cached } from '../../../core/cache';
import { mesurerQualite } from '../../../core/resolution';

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

  // LES TITRES SONT CHERCHES EN PARALLELE, l'ordre etant conserve pour la selection.
  //
  // C'etait une boucle sequentielle : un aller-retour HTTP PAR TITRE. Tant qu'on n'en
  // portait qu'un ou deux, cela passait ; en ajoutant le titre international, la source
  // s'est mise a depasser le budget du fan-out et disparaissait des recherches a froid.
  // Or c'est la seule qui rende un flux immediatement jouable, sans debrideur : la
  // perdre, c'est rendre une liste vide a qui n'a pas de compte.
  //
  // Un titre qui ne rend rien ne coute plus le delai des suivants. La PRIORITE, elle,
  // ne change pas : on parcourt les titres dans l'ordre, et le premier qui donne une
  // correspondance l'emporte — comme avant.
  const recherches = await Promise.all(
    q.titles.map((titre) => (titre ? search(titre, signal).catch(() => []) : Promise.resolve([]))),
  );

  for (let i = 0; i < q.titles.length; i++) {
    const title = q.titles[i];
    if (!title) continue;
    const results = recherches[i];
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
 * Vraie resolution du flux, quand le budget le permet.
 *
 * KissKH n'annonce rien : sa playlist ne liste que des segments, et son API ne rend
 * qu'une URL. La mesure descend donc jusqu'au SPS du flux (cf. core/resolution.ts).
 * Le garde-fou reste le budget : si le fan-out est deja serre, on n'engage pas la
 * lecture et on assume l'etiquette generique.
 */
async function probeQuality(hlsUrl: string, ctx: SearchContext): Promise<string> {
  const mesuree = await mesurerQualite(hlsUrl, {
    signal: ctx.deadline.signal,
    restantMs: ctx.restant(),
  });
  return mesuree ?? 'HD';
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
