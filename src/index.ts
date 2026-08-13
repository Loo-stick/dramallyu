// Point d'entree : cablage HTTP et rien d'autre.
//
// Ce fichier doit RESTER court. L'anti-modele est le src/index.ts de LooStream, 146 Ko,
// ou routes, handlers, admin, sante et scrapers ont fini empiles au meme endroit.
// Toute logique va dans core/, sources/, routes/.

import express from 'express';
import rateLimit from 'express-rate-limit';
import * as path from 'path';

import { getManifest } from './routes/manifest';
import { handleStream } from './routes/stream';
import { handleSubtitles, handleServeSub } from './routes/subtitles';
import { handleCatalog } from './routes/catalog';
import { handleMeta } from './routes/meta';
import { handleResolve } from './routes/resolve';
import { handleKeyTest, tester } from './routes/keytest';
import {
  adminEnabled,
  requireAdmin,
  handleLogin,
  handleLogout,
  handleAdminState,
  handleGetConfigFiles,
  handleSaveConfigFile,
  handleToggleSource,
  handleClearCache,
  handleRediscoverKkey,
} from './routes/admin';
import { register, planSources } from './core/registry';
import {
  parseConfig,
  encodeConfig,
  chiffrementDisponible,
  estSentinelle,
  CHAMPS_CLES,
  CHAMPS_REGLAGES,
} from './core/config';
import { getSettings } from './core/settings';
import { getCacheStats } from './core/cache';
import { kkeyStatus } from './sources/direct/kisskh/kkey';
import { kisskhSource } from './sources/direct/kisskh';
import { demarrerDomainSync, synchroniserMaintenant, dernierEtat } from './core/domain-sync';
import { voirdramaSource } from './sources/direct/voirdrama';
import { nyaaSource } from './sources/torrent/nyaa';
import { torznabSources } from './sources/torrent/torznab';
import { makeUnit3dSource } from './sources/torrent/unit3d';
import { digitalcoreSource } from './sources/torrent/digitalcore';
import { zoneTelechargementSource } from './sources/ddl/zonetelechargement';
import { wawacitySource } from './sources/ddl/wawacity';

const app = express();
const PORT = Number(process.env.PORT || 7020);

// Derriere Apache + Cloudflare : sans ca, les URLs auto-referentes (/resolve, /sub)
// sont construites avec le schema et l'hote internes, donc injouables chez le client.
app.set('trust proxy', 1);

// --- Sources ----------------------------------------------------------------
register(
  kisskhSource,
  voirdramaSource,
  nyaaSource,
  ...torznabSources(),
  makeUnit3dSource('g3mini', 'G3mini', 'g3mini'),
  makeUnit3dSource('darkpeers', 'DarkPeers', 'dpeers'),
  digitalcoreSource,
  zoneTelechargementSource,
  wawacitySource,
);

// --- Garde-fous --------------------------------------------------------------
app.use((_req, res, next) => {
  // Stremio et Nuvio appellent l'addon depuis une origine web : sans CORS, rien ne
  // s'affiche cote navigateur.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // La lecture d'un sous-titre ou d'un flux genere des rafales legitimes.
  skip: (req) => req.path.startsWith('/sub/') || req.path.startsWith('/resolve/'),
});
app.use(limiter);

// --- Protocole Stremio -------------------------------------------------------
// Chaque ressource existe en deux formes : sans config (decouverte, AIOStreams) et
// avec le segment de config de l'utilisateur.

const manifest = (_req: express.Request, res: express.Response): void => {
  // JAMAIS gate : un manifeste protege rend l'addon inagregeable par AIOStreams.
  res.json(getManifest());
};
app.get('/manifest.json', manifest);
app.get('/:config/manifest.json', manifest);

app.get('/stream/:type/:id.json', handleStream);
app.get('/:config/stream/:type/:id.json', handleStream);

app.get('/subtitles/:type/:id.json', handleSubtitles);
app.get('/subtitles/:type/:id/:extra.json', handleSubtitles);
app.get('/:config/subtitles/:type/:id.json', handleSubtitles);
app.get('/:config/subtitles/:type/:id/:extra.json', handleSubtitles);

app.get('/catalog/:type/:id.json', handleCatalog);
app.get('/catalog/:type/:id/:extra.json', handleCatalog);
app.get('/:config/catalog/:type/:id.json', handleCatalog);
app.get('/:config/catalog/:type/:id/:extra.json', handleCatalog);

app.get('/meta/:type/:id.json', handleMeta);
app.get('/:config/meta/:type/:id.json', handleMeta);

// --- Lecture -----------------------------------------------------------------
app.get('/resolve/:token', handleResolve);
app.get('/sub/:token', handleServeSub);
// Variantes prefixees par la config : les jetons sont autonomes, mais des liens
// deja distribues peuvent porter le segment. Les ignorer donnerait un 404 au Play.
app.get('/:config/resolve/:token', handleResolve);
app.get('/:config/sub/:token', handleServeSub);

// --- Pages -------------------------------------------------------------------
const WEB_DIR = path.join(__dirname, 'web');
const sendConfigure = (_req: express.Request, res: express.Response): void => {
  res.sendFile(path.join(WEB_DIR, 'configure.html'));
};
app.get('/configure', sendConfigure);
app.get('/:config/configure', sendConfigure);
app.get('/', (_req, res) => res.redirect('/configure'));

// --- API de service ----------------------------------------------------------
const startedAt = Date.now();

// Volontairement NON gate : c'est la sonde du healthcheck Docker.
app.get('/api/stats', (_req, res) => {
  res.json({
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    cache: getCacheStats(),
    kkey: kkeyStatus(),
  });
});

/** Champs qui donnent acces a un service tiers. Ils ne ressortent JAMAIS du serveur. */
const CHAMPS_SECRETS = CHAMPS_CLES;

/**
 * Relit une configuration pour reafficher le formulaire.
 *
 * Renvoie les REGLAGES en clair, et pour chaque cle un simple booleen de presence.
 * Renvoyer les cles elles-memes annulerait le chiffrement : quiconque detient le lien
 * pourrait ouvrir /configure et les recopier pour s'en servir ailleurs. Le formulaire
 * affiche donc « cle enregistree » et le serveur la reconduit tout seul.
 */
app.post('/api/config/decoder', express.json({ limit: '8kb' }), (req, res) => {
  const segment = String((req.body as Record<string, unknown>)?.config || '');
  if (!segment) {
    res.json({ trouve: false });
    return;
  }
  const cfg = parseConfig(segment);
  const cles: Record<string, boolean> = {};
  for (const champ of CHAMPS_SECRETS) cles[champ] = Boolean(cfg[champ]);

  const { ad, tb, c411, tr4ker, tmdb, ...reglages } = cfg;
  void ad;
  void tb;
  void c411;
  void tr4ker;
  void tmdb;

  res.json({ trouve: true, reglages, cles });
});

/**
 * Encode la configuration d'un utilisateur.
 *
 * La page /configure ne peut pas chiffrer elle-meme : la cle est cote serveur, et
 * elle doit y rester. Elle poste donc sa configuration ici et recoit le segment
 * chiffre. Rien n'est stocke : le serveur voit ces cles a chaque requete de flux de
 * toute façon, il ne les conserve nulle part.
 */
/**
 * Etat des comptes relies a une configuration.
 *
 * La page affiche « compte relie » plutot qu'un champ de saisie ; cet endpoint lui
 * dit A QUEL compte, et si l'abonnement tient toujours. La cle sert le temps de
 * l'appel et ne ressort jamais.
 */
app.post('/api/config/comptes', express.json({ limit: '8kb' }), async (req, res) => {
  const cfg = parseConfig(String((req.body as Record<string, unknown>)?.config || '') || null);
  const services: Record<string, string> = {
    ad: 'alldebrid', tb: 'torbox', c411: 'c411', tr4ker: 'tr4ker', tmdb: 'tmdb',
  };

  const etats: Record<string, unknown> = {};
  await Promise.all(
    Object.entries(services).map(async ([champ, service]) => {
      const cle = cfg[champ as 'ad'];
      if (!cle) return;
      etats[champ] = await tester(service, cle);
    }),
  );
  res.json({ comptes: etats });
});

app.post('/api/config/encoder', express.json({ limit: '8kb' }), (req, res) => {
  const cfg = parseConfig(null);
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Reconduction des cles que le formulaire n'a pas pu reafficher. Sans ca, modifier
  // un simple reglage effacerait toutes les cles de l'utilisateur.
  const precedent = parseConfig(String(body._precedent || '') || null);
  const aVider = Array.isArray(body._vider) ? (body._vider as string[]) : [];
  for (const champ of CHAMPS_SECRETS) {
    // Le formulaire affiche une SENTINELLE (des puces) a la place d'une cle
    // enregistree, et il est cense ne jamais la renvoyer. On le verifie quand meme
    // ICI : sinon une page en cache, une version ancienne ou une erreur de script
    // suffirait a remplacer la vraie cle par des puces — l'utilisateur perdrait son
    // acces sans rien avoir tape. La protection ne peut pas vivre que dans le
    // navigateur.
    if (estSentinelle(body[champ])) delete body[champ];
    if (aVider.includes(champ)) continue;
    if (!body[champ] && precedent[champ]) body[champ] = precedent[champ];
  }

  // On repasse par parseConfig pour VALIDER : le formulaire ne doit pas pouvoir
  // injecter des champs arbitraires dans le blob.
  const propre = parseConfig(
    Buffer.from(JSON.stringify(body), 'utf-8').toString('base64url'),
  );
  const aChange = (k: keyof typeof propre): boolean =>
    JSON.stringify(propre[k]) !== JSON.stringify(cfg[k]);

  const compact: Record<string, unknown> = {};
  for (const champ of CHAMPS_CLES) {
    if (propre[champ]) compact[champ] = propre[champ];
  }
  // Plus de liste a tenir ici : elle est DERIVEE des valeurs par defaut (cf.
  // CHAMPS_REGLAGES). Trois reglages avaient ete oublies a trois moments differents,
  // chacun accepte par le formulaire puis absent du lien, sans le moindre signal.
  for (const champ of CHAMPS_REGLAGES) {
    if (aChange(champ)) compact[champ] = propre[champ];
  }

  res.json({ config: encodeConfig(compact), chiffre: chiffrementDisponible() });
});

app.get('/api/test-cle', handleKeyTest);

/**
 * Meme reponse que GET /api/sources, mais a partir d'une config BRUTE.
 *
 * La page de configuration s'en sert pour montrer en direct quelles sources
 * tourneront reellement : sans ca, elle devrait d'abord faire chiffrer la config puis
 * la renvoyer, soit deux allers-retours a chaque frappe. Et surtout, la reponse vient
 * du MEME `planSources` que le moteur — la page ne peut donc pas mentir sur ce qui
 * s'executera vraiment.
 */
app.post('/api/sources', express.json({ limit: '8kb' }), (req, res) => {
  const config = parseConfig(
    Buffer.from(JSON.stringify(req.body ?? {}), 'utf-8').toString('base64url'),
  );
  res.json({
    sources: planSources(config).map(({ source, skip }) => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
      needsDebrid: source.needsDebrid,
      requiredUserKey: source.requiredUserKey,
      active: !skip,
      skip,
    })),
  });
});

app.get('/api/sources', (req, res) => {
  const config = parseConfig(String(req.query.config || ''));
  res.json({
    settings: getSettings(),
    sources: planSources(config).map(({ source, skip }) => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
      needsDebrid: source.needsDebrid,
      requiredUserKey: source.requiredUserKey,
      active: !skip,
      skip,
    })),
  });
});

// --- Administration ----------------------------------------------------------
// Entierement absente si ADMIN_PASSWORD n'est pas defini : une page d'administration
// sans mot de passe serait pire que pas de page du tout.
const jsonBody = express.json({ limit: '256kb' });
const formBody = express.urlencoded({ extended: false, limit: '16kb' });

app.get('/admin/login', (_req, res) => {
  if (!adminEnabled()) {
    res.status(404).type('text/plain').send('administration desactivee (ADMIN_PASSWORD absent)');
    return;
  }
  res.sendFile(path.join(WEB_DIR, 'login.html'));
});
app.post('/admin/login', formBody, handleLogin);
app.post('/admin/logout', handleLogout);
app.get('/admin', requireAdmin, (_req, res) => res.sendFile(path.join(WEB_DIR, 'admin.html')));

app.get('/api/admin/etat', requireAdmin, handleAdminState);
app.get('/api/admin/config', requireAdmin, handleGetConfigFiles);
app.post('/api/admin/config/:name', requireAdmin, jsonBody, handleSaveConfigFile);
app.post('/api/admin/sources/:id', requireAdmin, jsonBody, handleToggleSource);
app.post('/api/admin/cache/vider', requireAdmin, jsonBody, handleClearCache);
app.post('/api/admin/kkey/redecouvrir', requireAdmin, handleRediscoverKkey);

app.get('/api/admin/domaines', requireAdmin, (_req, res) => res.json({ dernier: dernierEtat() }));
app.post('/api/admin/domaines/synchroniser', requireAdmin, async (_req, res) => {
  res.json({ resultats: await synchroniserMaintenant() });
});

app.listen(PORT, () => {
  console.log(`[Dramallyu] ecoute sur le port ${PORT}`);
  // Apres l'ecoute : repondre aux requetes passe avant d'interroger Telegram.
  demarrerDomainSync();
  console.log(`[Dramallyu] configuration : http://localhost:${PORT}/configure`);
});

export { app };
