// Compression des reponses textuelles.
//
// Tout ce que cet addon renvoie est du texte tres redondant : du JSON dont chaque flux
// repete la meme structure, et des sous-titres WebVTT ou l'horodatage occupe la moitie
// des octets. Ces deux formats se compriment d'un facteur cinq a dix.
//
// Mesure qui a impose ce fichier : une piste de sous-titres pesait 52 919 octets
// servis tels quels, et chaque selection dans le lecteur les retransferait. Sur une
// liaison domestique, derriere Cloudflare, c'est du temps que l'utilisateur voit.
//
// AUCUNE DEPENDANCE. `compression` ferait le travail, mais zlib est dans Node et le
// besoin tient en trente lignes — ajouter un paquet pour ça serait disproportionne.

import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';

/**
 * En dessous, comprimer coute plus qu'il ne rapporte : l'en-tete gzip pese une
 * vingtaine d'octets et le temps processeur n'est pas nul. Les petites reponses JSON
 * (un manifeste, une liste vide) passent donc telles quelles.
 */
const SEUIL_OCTETS = 1024;

/** Types comprimes. Tout le reste — video, images — l'est deja ou ne s'y prete pas. */
const TYPES = /^(application\/json|text\/(vtt|plain|html|css)|application\/javascript)/i;

export function compression(req: Request, res: Response, next: NextFunction): void {
  const accepte = String(req.headers['accept-encoding'] || '');
  const brotli = /\bbr\b/.test(accepte);
  const gzip = /\bgzip\b/.test(accepte);
  if (!brotli && !gzip) return next();

  const envoyer = res.send.bind(res);

  res.send = function (corps?: unknown): Response {
    try {
      // On ne comprime que ce qu'on a reellement produit en texte. Un flux, un
      // Buffer binaire ou une redirection ne passent pas par ici.
      if (typeof corps !== 'string' || corps.length < SEUIL_OCTETS) return envoyer(corps);
      if (res.getHeader('Content-Encoding')) return envoyer(corps);
      if (!TYPES.test(String(res.getHeader('Content-Type') || ''))) return envoyer(corps);

      const brut = Buffer.from(corps, 'utf-8');
      // Brotli comprime mieux que gzip sur du texte, pour un cout comparable a ces
      // tailles. On le prefere quand le client l'accepte — tous les navigateurs et
      // lecteurs modernes le font.
      const comprime = brotli
        ? brotliCompressSync(brut, {
            params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
          })
        : gzipSync(brut, { level: 6 });

      // Si la compression n'apporte rien, on sert l'original : payer un decodage pour
      // economiser trois octets serait absurde.
      if (comprime.length >= brut.length) return envoyer(corps);

      res.setHeader('Content-Encoding', brotli ? 'br' : 'gzip');
      res.setHeader('Content-Length', String(comprime.length));
      // Les caches intermediaires doivent savoir que la reponse varie selon l'encodage
      // accepte, sans quoi ils serviraient du comprime a un client qui ne sait pas le
      // lire.
      res.setHeader('Vary', 'Accept-Encoding');
      return envoyer(comprime);
    } catch {
      // La compression ne doit JAMAIS empecher la reponse de partir.
      return envoyer(corps);
    }
  } as Response['send'];

  next();
}
