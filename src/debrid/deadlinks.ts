// Memoire des liens morts.
//
// Les hebergeurs retirent les fichiers, et les sites DDL ne mettent pas leurs fiches a
// jour : un lien reste publie longtemps apres avoir cesse d'exister. Verifie en
// production sur Zone-Telechargement, y compris sur du contenu recent — la chaine
// fonctionne, le protecteur est resolu, l'hebergeur est bien supporte, et AllDebrid
// repond `LINK_DOWN`.
//
// On ne peut pas le savoir avant le Play : le verifier a l'avance couterait un
// deblocage par lien a chaque ouverture de fiche, ce qui est lent et consomme le quota
// de l'utilisateur. En revanche, une fois qu'on l'a appris, il n'y a aucune raison de
// reproposer ce lien. C'est ce que fait wastream avec son service dead_links.
//
// Consequence agreable : la liste s'ameliore d'elle-meme a l'usage.

import { get as cacheGet, set as cacheSet } from '../core/cache';

// Assez long pour eviter de reproposer un lien mort pendant des semaines, assez court
// pour qu'un fichier re-televerse finisse par revenir.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function cle(url: string): string {
  return `mort:${url}`;
}

/** A appeler quand un debrideur affirme que le fichier n'existe plus. */
export function marquerMort(url: string): void {
  if (!url) return;
  cacheSet(cle(url), true, TTL_MS, 'liensmorts');
  console.log(`[LienMort] retenu : ${url.slice(0, 60)}`);
}

export function estMort(url: string): boolean {
  return cacheGet<boolean>(cle(url)) === true;
}

/** Retire d'une liste les liens deja connus comme morts. */
export function filtrerMorts<T>(items: T[], urlDe: (item: T) => string | undefined): T[] {
  return items.filter((item) => {
    const url = urlDe(item);
    return !url || !estMort(url);
  });
}
