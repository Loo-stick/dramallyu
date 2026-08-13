// Test des cles depuis la page /configure.
//
// POURQUOI COTE SERVEUR : le navigateur ne peut pas interroger AllDebrid, TorBox ou
// un Torznab directement — ces API ne renvoient pas d'en-tetes CORS. Sans ces
// endpoints, l'utilisateur ne decouvrirait une cle fautive qu'au premier film qui ne
// se lance pas, sans savoir laquelle est en cause.
//
// Rien n'est stocke : la cle sert le temps d'un appel et disparait. Elle n'est pas
// journalisee non plus — une cle dans les logs serait une fuite.

import type { Request, Response } from 'express';
import { httpGet, getJson } from '../core/http';
import { getSettings } from '../core/settings';

export interface Verdict {
  ok: boolean;
  /** Message court, destine a etre affiche tel quel. */
  message: string;
  /** Details utiles quand ca marche : pseudo, echeance de l'abonnement... */
  detail?: string;
}

const TIMEOUT = 12000;

async function testAllDebrid(cle: string): Promise<Verdict> {
  const data = await getJson<{
    status?: string;
    data?: { user?: { username?: string; isPremium?: boolean; premiumUntil?: number } };
    error?: { code?: string; message?: string };
  }>('https://api.alldebrid.com/v4/user?agent=dramallyu', {
    headers: { Authorization: `Bearer ${cle}` },
    timeoutMs: TIMEOUT,
    retries: 0,
  });

  if (!data) return { ok: false, message: 'AllDebrid injoignable. Reessayez dans un instant.' };
  if (data.error || !data.data?.user) {
    return { ok: false, message: 'Cle refusee par AllDebrid.' };
  }

  const u = data.data.user;
  if (!u.isPremium) {
    // Techniquement valide, mais inutilisable : mieux vaut le dire maintenant.
    return {
      ok: false,
      message: 'Cle valide, mais le compte n est pas premium.',
      detail: 'Le debridage exige un abonnement actif.',
    };
  }
  const fin = u.premiumUntil ? new Date(u.premiumUntil * 1000).toLocaleDateString('fr-FR') : null;
  return {
    ok: true,
    message: `Compte AllDebrid valide${u.username ? ` (${u.username})` : ''}.`,
    detail: fin ? `Premium jusqu au ${fin}.` : undefined,
  };
}

async function testTorbox(cle: string): Promise<Verdict> {
  // httpGet et non getJson : TorBox refuse une cle avec un 403 PORTANT un corps
  // explicite. Traiter tout non-2xx comme une panne dirait « injoignable » a
  // quelqu'un dont la cle est simplement fausse — le pire message possible, puisqu'il
  // envoie chercher le probleme du mauvais cote.
  const res = await httpGet<{
    success?: boolean;
    error?: string;
    data?: { email?: string; plan?: number; premium_expires_at?: string };
  }>('https://api.torbox.app/v1/api/user/me?settings=false', {
    headers: { Authorization: `Bearer ${cle}` },
    timeoutMs: TIMEOUT,
    retries: 0,
  });

  if (!res) return { ok: false, message: 'TorBox injoignable. Reessayez dans un instant.' };
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'Cle refusee par TorBox.' };
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, message: `TorBox a repondu ${res.status}.` };
  }

  const data = res.data;
  if (!data?.success || !data.data) return { ok: false, message: 'Cle refusee par TorBox.' };

  const plan = data.data.plan ?? 0;
  if (plan === 0) {
    return {
      ok: false,
      message: 'Cle valide, mais le compte est en offre gratuite.',
      detail: 'Le debridage de torrents exige un plan payant.',
    };
  }
  const fin = data.data.premium_expires_at
    ? new Date(data.data.premium_expires_at).toLocaleDateString('fr-FR')
    : null;
  return {
    ok: true,
    message: `Compte TorBox valide${data.data.email ? ` (${data.data.email})` : ''}.`,
    detail: fin ? `Abonnement jusqu au ${fin}.` : undefined,
  };
}

async function testTmdb(cle: string): Promise<Verdict> {
  // TMDB a deux formats : cle v3 (32 caracteres hexadecimaux, en query) et jeton v4
  // (JWT, en en-tete). On accepte les deux plutot que de faire echouer quelqu'un qui
  // a copie le mauvais champ de son compte.
  const estJeton = cle.split('.').length === 3 && cle.length > 100;

  const res = estJeton
    ? await httpGet('https://api.themoviedb.org/3/configuration', {
        headers: { Authorization: `Bearer ${cle}` },
        timeoutMs: TIMEOUT,
        retries: 0,
      })
    : await httpGet(
        `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(cle)}`,
        { timeoutMs: TIMEOUT, retries: 0 },
      );

  if (!res) return { ok: false, message: 'TMDB injoignable. Reessayez dans un instant.' };
  if (res.status === 401) {
    return { ok: false, message: `Cle ${estJeton ? 'v4' : 'v3'} refusee par TMDB.` };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, message: `TMDB a repondu ${res.status}.` };
  }
  return {
    ok: true,
    message: `Cle TMDB ${estJeton ? 'v4' : 'v3'} valide.`,
    detail: 'Titres et synopsis seront servis en francais.',
  };
}

/**
 * Tracker UNIT3D. On interroge l'endpoint de RECHERCHE, pas une page d'accueil : lui
 * seul authentifie, et c'est celui que la source utilisera vraiment.
 */
async function testUnit3d(id: string, cle: string): Promise<Verdict> {
  const conf = getSettings().unit3d?.[id];
  if (!conf) return { ok: false, message: `Tracker « ${id} » inconnu.` };
  if (!conf.enabled) return { ok: false, message: `Tracker « ${id} » desactive par l operateur.` };

  const url = `${conf.url.replace(/\/+$/, '')}/api/torrents/filter?perPage=1`;
  const res = await httpGet<unknown>(url, {
    timeoutMs: TIMEOUT,
    retries: 0,
    headers: { Authorization: `Bearer ${cle}`, Accept: 'application/json' },
  });

  if (!res) return { ok: false, message: 'Tracker injoignable. Il est peut-etre hors ligne.' };
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'Cle refusee par le tracker.' };
  if (res.status === 429) return { ok: false, message: 'Trop de requetes. Reessayez dans une minute.' };
  if (res.status < 200 || res.status >= 300) return { ok: false, message: `Le tracker a repondu ${res.status}.` };

  // LE CODE HTTP NE SUFFIT PAS. Constate sur G3mini : un compte banni recoit
  // `200 OK` accompagne de `{"message":"Ce compte est banni !"}`. Se fier au seul
  // statut donnait donc « Cle acceptee » a quelqu'un dont le compte est ferme — le
  // pire des verdicts, puisqu'il installe, croit la source active, et ne comprend
  // jamais pourquoi elle ne remonte rien.
  //
  // Meme lecon que sur Torznab, ou `t=caps` validait n'importe quelle cle.
  const corps = res.data as { data?: unknown; message?: string } | unknown[] | null;
  if (corps && !Array.isArray(corps) && typeof corps === 'object') {
    // Le tracker explique lui-meme le refus : on relaie son message plutot qu'un
    // « cle refusee » vague qui enverrait chercher au mauvais endroit.
    if (typeof corps.message === 'string' && !Array.isArray(corps.data)) {
      return { ok: false, message: `Tracker : ${corps.message}` };
    }
    if (Array.isArray(corps.data)) return { ok: true, message: 'Cle acceptee.' };
  }
  if (Array.isArray(corps)) return { ok: true, message: 'Cle acceptee.' };
  return { ok: false, message: 'Reponse inattendue : la cle est probablement invalide.' };
}

/**
 * DigitalCore. Son API rend un TABLEAU JSON sur une recherche authentifiee ; une cle
 * refusee ne rend pas un tableau. On verifie donc la forme, pas seulement le code —
 * un 200 accompagne d'une page de connexion ne doit pas passer pour un succes.
 */
async function testDigitalCore(cle: string): Promise<Verdict> {
  const conf = getSettings().digitalcore;
  if (!conf?.enabled) return { ok: false, message: 'DigitalCore desactive par l operateur.' };

  const url = `${conf.url.replace(/\/+$/, '')}/api/v1/torrents?searchText=test&apikey=${encodeURIComponent(cle)}`;
  const res = await httpGet<unknown>(url, {
    timeoutMs: TIMEOUT,
    retries: 0,
    headers: { Accept: 'application/json' },
  });

  if (!res) return { ok: false, message: 'Tracker injoignable. Il est peut-etre hors ligne.' };
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'Cle refusee par le tracker.' };
  if (res.status < 200 || res.status >= 300) return { ok: false, message: `Le tracker a repondu ${res.status}.` };
  if (!Array.isArray(res.data)) return { ok: false, message: 'Reponse inattendue : la cle est probablement invalide.' };
  return { ok: true, message: 'Cle acceptee.' };
}

async function testTorznab(indexeur: string, cle: string): Promise<Verdict> {
  const conf = getSettings().torznab[indexeur];
  if (!conf) return { ok: false, message: `Indexeur « ${indexeur} » inconnu.` };
  if (!conf.enabled) return { ok: false, message: `Indexeur « ${indexeur} » desactive par l operateur.` };

  // ON INTERROGE `t=search`, PAS `t=caps`.
  //
  // Verifie sur C411 : `t=caps` repond 200 avec un <caps> complet meme pour une cle
  // inventee — il n'authentifie pas. Le tester donnait donc un « cle acceptee » a
  // n'importe qui, ce qui est pire que pas de test du tout : la personne installe,
  // croit son tracker actif, et ne comprend pas pourquoi il ne remonte jamais rien.
  //
  // `t=search` authentifie : 401 + <error code="100" description="Invalid API Key"/>.
  const url =
    `${conf.url.replace(/\/+$/, '')}?t=search&q=test&limit=1&apikey=${encodeURIComponent(cle)}`;
  const res = await httpGet<string>(url, { timeoutMs: TIMEOUT, retries: 0, responseType: 'text' });

  if (!res) return { ok: false, message: 'Indexeur injoignable. Il est peut-etre hors ligne.' };

  const corps = String(res.data || '');

  // L'erreur Torznab porte une description lisible : la relayer evite le message
  // vague (« cle refusee ») quand le vrai probleme est ailleurs — quota, compte
  // suspendu, cle expiree.
  const desc = corps.match(/<error[^>]*description="([^"]*)"/i);
  if (desc) return { ok: false, message: `Indexeur : ${desc[1]}` };

  if (res.status === 401 || res.status === 403) return { ok: false, message: 'Cle refusee par l indexeur.' };
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, message: `L indexeur a repondu ${res.status}.` };
  }
  if (!corps.includes('<rss') && !corps.includes('<channel')) {
    return { ok: false, message: 'Reponse inattendue : ce n est pas un Torznab.' };
  }

  return { ok: true, message: 'Indexeur joignable et cle acceptee.' };
}

/** Verdict pour un service et une cle. Reutilise par l'endpoint et par la relecture. */
export async function tester(service: string, cle: string): Promise<Verdict> {
  if (!cle) return { ok: false, message: 'Renseignez une cle avant de tester.' };
  try {
    switch (service) {
      case 'alldebrid':
        return await testAllDebrid(cle);
      case 'torbox':
        return await testTorbox(cle);
      case 'tmdb':
        return await testTmdb(cle);
      case 'c411':
      case 'tr4ker':
        return await testTorznab(service, cle);
      case 'ygg':
        return await testTorznab('yggreborn', cle);
      case 'g3mini':
        return await testUnit3d(service, cle);
      case 'dpeers':
        return await testUnit3d('darkpeers', cle);
      case 'dcore':
        return await testDigitalCore(cle);
      default:
        return { ok: false, message: `Service « ${service} » inconnu.` };
    }
  } catch (e) {
    // On ne renvoie jamais le message d'exception brut : il peut contenir l'URL
    // complete, donc la cle.
    console.log(`[TestCle] ${service} : echec (${(e as Error).name})`);
    return { ok: false, message: 'Le test a echoue. Reessayez dans un instant.' };
  }
}

export async function handleKeyTest(req: Request, res: Response): Promise<void> {
  const service = String(req.query.service || '').toLowerCase();
  const cle = String(req.query.key || '').trim();
  res.json(await tester(service, cle));
}
