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
import { noterSource } from './metrics';
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
  /** Candidats rapportes par chaque source, AVANT dedup et filtres. C'est la seule
   *  mesure qui dise si une source SERT a quelque chose. */
  apports: Record<string, number>;
  /** Sources abandonnees faute de budget. */
  timedOut: string[];
}

/**
 * Rechauffements simultanes tolerés, toutes requetes confondues.
 *
 * Chacun est un appel reseau qui continue apres la reponse. Sans plafond, un pic de
 * trafic empilerait autant de travaux de fond que de recherches — sur cette machine,
 * ou la memoire est la ressource rare, c'est exactement ce qu'il ne faut pas laisser
 * arriver. Au-dela, on coupe court : le cache ne se remplira pas cette fois-ci.
 */
const MAX_RECHAUFFEMENTS = 8;

let rechauffementsEnCours = 0;

/**
 * Rechauffements deja lances, par source et par recherche.
 *
 * Chaque fiche est demandee DEUX fois (le lecteur en direct, et AIOStreams qui relaie) :
 * sans cette garde, les deux lanceraient le meme travail de fond, pour le meme cache.
 */
const rechauffementsLances = new Set<string>();

export async function searchAll(
  query: Query,
  config: UserConfig,
  budgetMs?: number,
): Promise<FanoutResult> {
  const settings = getSettings();

  // DEUX HORIZONS, et c'est tout l'interet.
  //
  // Le premier est ce que l'appelant accorde a la REPONSE : passe ce delai, on repond
  // avec ce qu'on a. Le second est le temps qu'on laisse au TRAVAIL de se terminer,
  // apres la reponse, pour que son resultat entre en cache.
  //
  // Avant, il n'y en avait qu'un : une source plus lente que le budget etait avortee et
  // son travail jete. Elle ne remplissait donc jamais le cache — et se faisait couper a
  // l'identique a la recherche suivante. Une source structurellement lente n'apparaissait
  // JAMAIS. Desormais elle manque a la premiere recherche, et elle est la ensuite.
  const budgetReponse = Math.min(budgetMs ?? settings.fanoutBudgetMs, settings.fanoutBudgetMs);
  const budgetFond = Math.max(budgetReponse, settings.rechauffementMs);

  const active = planSources(config).filter((p) => !p.skip);
  const timings: Record<string, number> = {};
  const apports: Record<string, number> = {};
  const timedOut: string[] = [];

  const debutGlobal = Date.now();
  const echeance = new Promise<'delai'>((resolve) => {
    setTimeout(() => resolve('delai'), budgetReponse).unref?.();
  });

  const results = await Promise.all(
    active.map(async ({ source }) => {
      const started = Date.now();
      // Une echeance PAR SOURCE : le retard de l'une ne doit pas rogner le temps des
      // autres, et il faut pouvoir interrompre celle-ci sans toucher aux voisines.
      const deadline = new Deadline(budgetFond);
      const ctx: SearchContext = { config, deadline };

      const travail = source.search(query, ctx).then(
        (found) => ({ found, erreur: undefined as string | undefined }),
        (e) => ({ found: [] as Candidate[], erreur: (e as Error).message.slice(0, 120) }),
      );

      const issue = await Promise.race([travail, echeance]);

      if (issue === 'delai') {
        // Elle n'entrera pas dans CETTE reponse. La question est seulement de savoir si
        // on la laisse finir pour le cache, ou si on coupe.
        timings[source.id] = Date.now() - started;
        apports[source.id] = 0;
        timedOut.push(source.id);

        const cle = `${source.id}:${clefRecherche(query)}`;
        if (rechauffementsEnCours >= MAX_RECHAUFFEMENTS || rechauffementsLances.has(cle)) {
          deadline.arreter();
          travail.catch(() => undefined);
          return [] as Candidate[];
        }

        rechauffementsEnCours++;
        rechauffementsLances.add(cle);
        void travail
          .then((r) => {
            const ms = Date.now() - started;
            // Mesure quand meme : c'est la seule facon de savoir ce que la source
            // aurait rapporte, et donc si le budget merite d'etre revu.
            noterSource(source.id, ms, r.found.length, r.erreur);
            if (r.erreur) console.log(`[Rechauffement] ${source.id} : ${r.erreur}`);
            else console.log(`[Rechauffement] ${source.id} : ${r.found.length} candidat(s) en ${ms} ms, en cache`);
          })
          .catch(() => undefined)
          .finally(() => {
            rechauffementsEnCours--;
            rechauffementsLances.delete(cle);
          });

        return [] as Candidate[];
      }

      const ms = Date.now() - started;
      timings[source.id] = ms;
      apports[source.id] = issue.found.length;
      noterSource(source.id, ms, issue.found.length, issue.erreur);
      if (issue.erreur) console.log(`[Fanout] ${source.id}: ${issue.erreur}`);
      return issue.found;
    }),
  );

  if (timedOut.length > 0) {
    console.log(
      `[Fanout] repondu en ${Date.now() - debutGlobal} ms sans ${timedOut.join(', ')} ` +
        '(elles continuent pour le cache)',
    );
  }

  return { candidates: results.flat(), timings, apports, timedOut };
}

/** Signature d'une recherche : deux requetes identiques ne se rechauffent qu'une fois. */
function clefRecherche(q: Query): string {
  return [q.type, q.imdbId ?? '', q.tmdbId ?? '', q.kkhId ?? '', q.season ?? '', q.episode ?? ''].join('|');
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
