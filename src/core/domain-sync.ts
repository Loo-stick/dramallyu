// Synchronisation automatique des domaines rotatifs.
//
// Les sites DDL francais changent de domaine plusieurs fois par an, et l'ancien
// devient generalement un domaine PARQUE — il repond 200 avec de la publicite, donc
// une simple sonde de disponibilite ne suffit pas a detecter la bascule. C'est ce qui
// avait rendu Wawacity muet : `wawacity.pro` repondait parfaitement... en servant une
// regie publicitaire.
//
// Chaque site annonce son adresse courante sur son canal Telegram officiel, dont
// l'apercu public (`t.me/s/<canal>`) est lisible sans compte ni cle. Le domaine se
// trouve dans les metadonnees Open Graph du canal :
//
//   Wawacity            og:title       -> « Wawacity.estate »
//   Zone-Telechargement og:description -> « Communaute officielle de https://zone-telechargement.org/ »
//
// Mecanisme repris de wastream (`wastream/services/domain_sync.py`), porte ici en
// version compacte. Les canaux ont ete trouves par AUTO-DECOUVERTE : ils sont
// publies en lien sur les sites eux-memes, pas saisis a la main.
//
// GARDE-FOU CENTRAL : on n'ecrit JAMAIS un domaine sans l'avoir teste. Un canal
// piratage, un message mal formule ou une regex trop gourmande casserait sinon une
// source qui fonctionnait tres bien.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getText } from './http';
import { makeEndpointConfig } from './endpoint-config';

export type Strategie = 'og:title' | 'og:description';

export interface SiteSuivi {
  /** Canal Telegram, sans le @. */
  canal: string;
  /** Fragment attendu dans le nom d'hote — evite de retenir un domaine tiers. */
  fragment: string;
  strategie: Strategie;
  /** Fichier de config a mettre a jour (cle `base`). */
  fichier: string;
}

interface ConfigSync {
  actif: boolean;
  intervalleMinutes: number;
  sites: Record<string, SiteSuivi>;
}

const DEFAUTS: ConfigSync = {
  actif: true,
  intervalleMinutes: 360,
  sites: {
    wawacity: {
      canal: 'Wawacityofficiel',
      fragment: 'wawacity',
      strategie: 'og:title',
      fichier: 'wawacity-endpoints.json',
    },
    zonetelechargement: {
      canal: 'zone_telechargement_officielle',
      fragment: 'zone-telechargement',
      strategie: 'og:description',
      fichier: 'zonetelechargement-endpoints.json',
    },
  },
};

const store = makeEndpointConfig<Record<string, unknown>>(
  'domain-sync.json',
  'DOMAIN_SYNC_CONFIG',
  DEFAUTS as unknown as Record<string, unknown>,
);
export const reloadDomainSync = store.reload;

export function getSyncConfig(): ConfigSync {
  const raw = store.get() as Partial<ConfigSync>;
  return {
    actif: raw.actif !== false,
    intervalleMinutes: Math.max(30, Number(raw.intervalleMinutes) || DEFAUTS.intervalleMinutes),
    sites: { ...DEFAUTS.sites, ...(raw.sites || {}) },
  };
}

function configDir(): string {
  return fs.existsSync('/app/config') ? '/app/config' : path.join(process.cwd(), 'config');
}

/** Contenu d'une balise Open Graph. */
export function metaContent(html: string, propriete: string): string | null {
  const cible = `property="${propriete}"`;
  const at = html.indexOf(cible);
  if (at === -1) return null;
  // La balise complete entoure la propriete : on borne la fenetre de lecture.
  const debutBalise = html.lastIndexOf('<', at);
  const finBalise = html.indexOf('>', at);
  if (debutBalise === -1 || finBalise === -1) return null;
  const balise = html.slice(debutBalise, finBalise);

  const cle = 'content="';
  const k = balise.indexOf(cle);
  if (k === -1) return null;
  const debut = k + cle.length;
  const fin = balise.indexOf('"', debut);
  return fin === -1 ? null : balise.slice(debut, fin);
}

/**
 * Extrait un nom d'hote contenant le fragment attendu.
 *
 * Le fragment est ce qui empeche de retenir n'importe quoi : sur un canal qui parle
 * aussi d'autres sites, seul un hote contenant « wawacity » sera retenu pour Wawacity.
 */
export function extraireDomaine(texte: string, fragment: string): string | null {
  if (!texte) return null;
  const candidats = texte.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*\.[a-z0-9.-]*[a-z]{2,}/gi) || [];

  for (const brut of candidats) {
    const nettoye = brut.trim().replace(/[.,;:!?)\]}]+$/, '');
    const avecSchema = /^https?:\/\//i.test(nettoye) ? nettoye : `https://${nettoye}`;
    try {
      const hote = new URL(avecSchema).hostname.toLowerCase();
      if (hote.includes(fragment.toLowerCase())) return `https://${hote.replace(/^www\./, '')}`;
    } catch {
      // Candidat non analysable : on passe au suivant.
    }
  }
  return null;
}

/**
 * Le domaine repond-il vraiment, ET sans etre parque ?
 *
 * Les deux verifications comptent : un domaine parque repond 200 avec de la
 * publicite. Sans ce controle on remplacerait une adresse morte par une autre.
 */
async function domaineValide(url: string): Promise<boolean> {
  const html = await getText(`${url}/`, { timeoutMs: 15000, retries: 1, maxBytes: 2 * 1024 * 1024 });
  if (!html || html.length < 500) return false;
  return !/sk-park\.php|"mode":"iframe"|domain (?:is )?for sale|parking/i.test(html.slice(0, 4000));
}

function lireBaseActuelle(fichier: string): string | null {
  try {
    const p = path.join(configDir(), fichier);
    if (!fs.existsSync(p)) return null;
    const brut = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return typeof brut.base === 'string' ? brut.base : null;
  } catch {
    return null;
  }
}

function ecrireBase(fichier: string, base: string): boolean {
  try {
    const p = path.join(configDir(), fichier);
    const brut = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
    brut.base = base;
    brut._maj_auto = new Date().toISOString();
    fs.writeFileSync(p, `${JSON.stringify(brut, null, 2)}\n`, 'utf-8');
    return true;
  } catch (e) {
    console.error(`[DomainSync] ecriture de ${fichier} impossible : ${(e as Error).message}`);
    return false;
  }
}

export interface ResultatSite {
  site: string;
  ancien: string | null;
  trouve: string | null;
  applique: boolean;
  motif: string;
}

/** Verifie un site et applique le nouveau domaine s'il est different ET valide. */
export async function synchroniserSite(nom: string, site: SiteSuivi): Promise<ResultatSite> {
  const ancien = lireBaseActuelle(site.fichier);
  const base: ResultatSite = { site: nom, ancien, trouve: null, applique: false, motif: '' };

  const html = await getText(`https://t.me/s/${site.canal}`, {
    timeoutMs: 20000,
    retries: 1,
    maxBytes: 2 * 1024 * 1024,
  });
  if (!html) return { ...base, motif: 'canal Telegram injoignable' };

  const contenu = metaContent(html, site.strategie);
  if (!contenu) return { ...base, motif: `metadonnee ${site.strategie} absente` };

  const trouve = extraireDomaine(contenu, site.fragment);
  if (!trouve) return { ...base, motif: `aucun domaine « ${site.fragment} » dans ${site.strategie}` };

  const normaliser = (u: string): string => u.replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');
  if (ancien && normaliser(ancien) === normaliser(trouve)) {
    return { ...base, trouve, motif: 'deja a jour' };
  }

  // Le controle qui evite de casser une source qui marchait.
  if (!(await domaineValide(trouve))) {
    return { ...base, trouve, motif: 'domaine annonce injoignable ou parque — non applique' };
  }

  const ok = ecrireBase(site.fichier, trouve);
  return {
    ...base,
    trouve,
    applique: ok,
    motif: ok ? `mis a jour : ${ancien ?? '(vide)'} -> ${trouve}` : 'echec d ecriture',
  };
}

export async function synchroniserTout(): Promise<ResultatSite[]> {
  const cfg = getSyncConfig();
  const resultats: ResultatSite[] = [];

  for (const [nom, site] of Object.entries(cfg.sites)) {
    try {
      const r = await synchroniserSite(nom, site);
      resultats.push(r);
      const prefixe = r.applique ? '[DomainSync] CHANGEMENT' : '[DomainSync]';
      console.log(`${prefixe} ${nom} : ${r.motif}`);
    } catch (e) {
      resultats.push({
        site: nom,
        ancien: null,
        trouve: null,
        applique: false,
        motif: (e as Error).message.slice(0, 120),
      });
    }
  }
  return resultats;
}

let minuterie: NodeJS.Timeout | null = null;
let dernierResultat: { horodatage: number; resultats: ResultatSite[] } | null = null;

export function dernierEtat(): { horodatage: number; resultats: ResultatSite[] } | null {
  return dernierResultat;
}

/** Demarre la synchronisation periodique. Le premier passage est differe. */
export function demarrerDomainSync(): void {
  const cfg = getSyncConfig();
  if (!cfg.actif) {
    console.log('[DomainSync] desactive dans config/domain-sync.json');
    return;
  }

  const executer = async (): Promise<void> => {
    const resultats = await synchroniserTout();
    dernierResultat = { horodatage: Date.now(), resultats };
  };

  // Differe de 30 s : le demarrage sert a repondre aux requetes, pas a interroger
  // Telegram. Et `unref` empeche cette minuterie de retenir le processus.
  const demarrage = setTimeout(() => void executer(), 30_000);
  demarrage.unref();

  minuterie = setInterval(() => void executer(), cfg.intervalleMinutes * 60_000);
  minuterie.unref();
  console.log(`[DomainSync] actif, verification toutes les ${cfg.intervalleMinutes} min`);
}

/** Declenchement manuel depuis la page admin. */
export async function synchroniserMaintenant(): Promise<ResultatSite[]> {
  const resultats = await synchroniserTout();
  dernierResultat = { horodatage: Date.now(), resultats };
  return resultats;
}
