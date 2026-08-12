// Registre des sources et fan-out.
//
// Le fan-out est la piece qui tient la promesse « delivrer vite ». Trois regles :
//
//   1. BUDGET DUR partage. Une source lente est abandonnee, elle ne retarde pas les
//      autres. AIOStreams coupe une source qui depasse son propre delai : sans ce
//      budget, une seule source poussive rendrait l'addon invisible dans AIOStreams.
//   2. AUCUNE source ne peut faire echouer la requete. Une exception est journalisee
//      et vaut liste vide.
//   3. Les sources sans leur cle utilisateur sont ECARTEES AVANT l'appel — pas
//      appelees puis mises en echec. Elles ne consomment donc aucun budget.

import type { Candidate, Query, SearchContext, Source, SubTrack } from '../sources/types';
import type { UserConfig } from './config';
import { sourceEnabledForUser } from './config';
import { Deadline } from './http';
import { getSettings, sourceEnabledByOperator } from './settings';

const registry = new Map<string, Source>();

export function register(...sources: Source[]): void {
  for (const s of sources) registry.set(s.id, s);
}

export function allSources(): Source[] {
  return [...registry.values()];
}

export function getSource(id: string): Source | undefined {
  return registry.get(id);
}

/** Motif pour lequel une source ne tourne pas — expose dans /api/sources et l'admin. */
export type SkipReason = 'operateur' | 'utilisateur' | 'cle-absente';

export interface SourcePlan {
  source: Source;
  skip?: SkipReason;
}

/** Decide, source par source, si elle participe — sans rien appeler. */
export function planSources(config: UserConfig): SourcePlan[] {
  return allSources().map((source) => {
    if (!sourceEnabledByOperator(source.id)) return { source, skip: 'operateur' as const };
    if (!sourceEnabledForUser(config, source.id)) return { source, skip: 'utilisateur' as const };
    if (source.requiredUserKey && !config[source.requiredUserKey]) {
      return { source, skip: 'cle-absente' as const };
    }
    // Une source qui n'est jouable qu'a travers un debrideur n'a aucun interet pour
    // qui n'en a pas : ses resultats seraient tous injouables.
    if (source.needsDebrid && !config.ad && !config.tb) {
      return { source, skip: 'cle-absente' as const };
    }
    return { source };
  });
}

export interface FanoutResult {
  candidates: Candidate[];
  /** Duree par source, pour l'admin et le diagnostic. */
  timings: Record<string, number>;
  /** Sources abandonnees faute de budget. */
  timedOut: string[];
}

export async function searchAll(query: Query, config: UserConfig): Promise<FanoutResult> {
  const settings = getSettings();
  const deadline = new Deadline(settings.fanoutBudgetMs);
  const ctx: SearchContext = { config, deadline };

  const active = planSources(config).filter((p) => !p.skip);
  const timings: Record<string, number> = {};
  const timedOut: string[] = [];

  const results = await Promise.all(
    active.map(async ({ source }) => {
      const started = Date.now();
      try {
        const found = await source.search(query, ctx);
        timings[source.id] = Date.now() - started;
        return found;
      } catch (e) {
        timings[source.id] = Date.now() - started;
        if (deadline.expired()) {
          timedOut.push(source.id);
        } else {
          console.log(`[Fanout] ${source.id}: ${(e as Error).message.slice(0, 120)}`);
        }
        return [] as Candidate[];
      }
    }),
  );

  return { candidates: results.flat(), timings, timedOut };
}

/** Meme discipline pour les sous-titres : budget partage, aucune source bloquante. */
export async function subtitlesAll(query: Query, config: UserConfig): Promise<SubTrack[]> {
  const settings = getSettings();
  const deadline = new Deadline(settings.fanoutBudgetMs);
  const ctx: SearchContext = { config, deadline };

  const active = planSources(config).filter((p) => !p.skip && p.source.subtitles);
  const results = await Promise.all(
    active.map(async ({ source }) => {
      try {
        return (await source.subtitles!(query, ctx)) ?? [];
      } catch (e) {
        console.log(`[Fanout/subs] ${source.id}: ${(e as Error).message.slice(0, 120)}`);
        return [] as SubTrack[];
      }
    }),
  );
  return results.flat();
}
