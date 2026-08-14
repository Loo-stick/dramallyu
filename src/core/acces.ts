// Cle d'acces : qui a le droit d'utiliser cette instance.
//
// ELLE NE GARDE PAS LE MANIFESTE, et c'est la difference essentielle avec LooStream,
// qui repond 401 dessus. Un manifeste ne contient ni secret ni travail — mais surtout,
// AIOStreams doit pouvoir le LIRE pour agreger l'addon. Le proteger rendrait Dramallyu
// invisible a l'agregateur, c'est-a-dire inutilisable dans la configuration meme de
// son operateur.
//
// Ce qu'on garde, ce sont les routes qui COUTENT : le fan-out sur onze sources, les
// appels aux debrideurs, la resolution, le service des sous-titres.
//
// Sans `ACCESS_KEY` dans l'environnement, l'addon est OUVERT. C'est le defaut, et il
// est assume : un addon communautaire sans cle reste parfaitement legitime.

import * as crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { parseConfig } from './config';

export function accesRestreint(): boolean {
  return Boolean((process.env.ACCESS_KEY || '').trim());
}

/**
 * Comparaison a temps constant.
 *
 * Une comparaison naive fuit la cle par le temps de reponse, un caractere a la fois.
 * Le cout est nul ici, l'omission ne se rattrape pas.
 */
function correspond(fournie: string | undefined): boolean {
  const attendue = (process.env.ACCESS_KEY || '').trim();
  if (!fournie) return false;
  const a = Buffer.from(fournie);
  const b = Buffer.from(attendue);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Garde des routes couteuses. A monter AVANT elles, jamais devant le manifeste.
 *
 * Le message dit quoi faire : renvoyer « non autorise » sans expliquer ou se procurer
 * la cle laisse quelqu'un devant un mur sans porte.
 */
export function exigerAcces(req: Request, res: Response, next: NextFunction): void {
  if (!accesRestreint()) return next();

  const config = parseConfig((req.params as Record<string, string>).config);
  if (correspond(config.acces)) return next();

  res.status(401).type('text/plain; charset=utf-8').send(
    "Cette instance de Dramallyu demande une cle d'acces. " +
      'Renseignez-la sur la page de configuration, puis reinstallez le lien obtenu.',
  );
}
