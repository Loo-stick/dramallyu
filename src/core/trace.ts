// Trace d'une requete, rattachee a l'installation qui l'a declenchee.
//
// LE MANQUE QUE CE FICHIER COMBLE. Le journal general repond a « qu'est-ce qui se
// passe sur le serveur ». Il ne repond pas a « pourquoi CETTE personne ne voit rien »,
// qui est la question qu'on recoit vraiment. Sur un addon partage, plusieurs recherches
// se chevauchent : leurs lignes s'entrelacent dans le journal, et rien ne dit laquelle
// appartient a qui. Rechercher a la main dans 500 lignes melangees, c'est ce qu'on
// faisait jusqu'ici.
//
// COMMENT. `AsyncLocalStorage` propage un contexte a travers les `await` sans qu'aucune
// fonction ait a le transporter. On l'ouvre au debut de /stream ; tout ce que le code
// journalise ensuite — sources, HTTP, debrid, y compris a dix niveaux de profondeur —
// atterrit dans le bon seau, sans toucher a une seule des fonctions traversees.
//
// CE QU'ON N'Y MET PAS. Les lignes arrivent DEJA MASQUEES : c'est `journal.ts` qui
// appelle `capturerLigne`, apres `masquer()`. Aucun secret ne peut donc entrer ici,
// et par consequent aucun ne peut etre persiste ni affiche.

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Plafond par requete. Une recherche bavarde ne doit pas pouvoir faire grossir la
 * memoire ni la ligne qu'on ecrira en base — c'est la contrainte de premier ordre sur
 * cette machine. Au-dela, on cesse d'ajouter : les premieres lignes sont les plus
 * utiles, ce sont elles qui disent ce que la requete a tente.
 */
const MAX_LIGNES = 150;

interface Contexte {
  qui: string;
  lignes: string[];
  /** Vrai quand le plafond a ete atteint : la trace le dira, plutot que de mentir. */
  tronquee: boolean;
}

const stockage = new AsyncLocalStorage<Contexte>();

function heure(): string {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * Ajoute une ligne a la trace en cours, s'il y en a une.
 *
 * Hors requete — un rafraichissement de catalogue, une tache de fond — il n'y a pas de
 * contexte et cette fonction ne fait rien. C'est voulu : seul ce qu'une personne a
 * declenche lui est attribue.
 */
export function capturerLigne(texteMasque: string): void {
  const ctx = stockage.getStore();
  if (!ctx) return;
  if (ctx.lignes.length >= MAX_LIGNES) {
    ctx.tronquee = true;
    return;
  }
  ctx.lignes.push(`${heure()} ${texteMasque}`);
}

/** Ouvre un contexte pour la duree de `fn`. */
export function tracer<T>(qui: string, fn: () => Promise<T>): Promise<T> {
  return stockage.run({ qui, lignes: [], tronquee: false }, fn);
}

/** La trace accumulee, prete a etre conservee. Vide hors requete. */
export function traceCourante(): string {
  const ctx = stockage.getStore();
  if (!ctx) return '';
  const fin = ctx.tronquee ? `\n… trace tronquee a ${MAX_LIGNES} lignes` : '';
  return ctx.lignes.join('\n') + fin;
}

/** L'installation a l'origine de la requete en cours, si elle s'est nommee. */
export function quiCourant(): string | undefined {
  return stockage.getStore()?.qui || undefined;
}
