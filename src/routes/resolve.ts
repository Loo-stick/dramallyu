// Endpoint /resolve/<jeton> — le debridage, au moment du Play et pas avant.
//
// Stremio et Nuvio suivent la redirection 302 et lisent le lien final. Tout le cout
// (ajout du magnet, attente, generation du lien) est donc paye une seule fois, pour
// le flux que l'utilisateur a REELLEMENT choisi, et non pour les quarante qu'on lui
// a affiches.

import type { Request, Response } from 'express';
import { decodeToken } from '../debrid/token';
import { resolve } from '../debrid/resolver';

// Le lecteur abandonne bien avant : inutile de faire patienter plus longtemps.
const RESOLVE_TIMEOUT_MS = 45_000;

export async function handleResolve(req: Request, res: Response): Promise<void> {
  const payload = decodeToken(String(req.params.token || ''));
  if (!payload) {
    res.status(403).type('text/plain').send('lien de lecture invalide ou expire');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  // Si le lecteur raccroche, on arrete tout de suite : continuer a interroger le
  // debrideur pour personne est du gaspillage pur.
  req.on('close', () => controller.abort());

  try {
    const link = await resolve(
      {
        kind: payload.k,
        value: payload.v,
        fileHint: payload.f,
        torrentUrl: payload.t,
        ad: payload.ad,
        tb: payload.tb,
        mfpUrl: payload.mu,
        mfpPass: payload.mp,
        mfpPour: payload.mq,
        pref: payload.pref,
      },
      controller.signal,
    );
    if (!link) {
      // Cas de loin le plus frequent : le fichier n'etait pas en cache, le debrideur
      // vient de LANCER son telechargement. Dire « echec » serait faux — le flux
      // deviendra jouable, il faut juste attendre. Un message vague enverrait
      // l'utilisateur verifier ses cles, qui n'y sont pour rien.
      res
        .status(502)
        .type('text/plain; charset=utf-8')
        .send(
          "Ce fichier n'etait pas pret chez votre debrideur : son telechargement vient " +
            "d'etre lance. Reessayez dans quelques minutes, ou choisissez un flux marque " +
            '« pret ».',
        );
      return;
    }
    res.redirect(302, link);
  } catch (e) {
    console.error(`[Resolve] ${(e as Error).message.slice(0, 120)}`);
    res.status(502).type('text/plain').send('echec de la resolution');
  } finally {
    clearTimeout(timer);
  }
}
