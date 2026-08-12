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
import { register, planSources } from './core/registry';
import { parseConfig } from './core/config';
import { getSettings } from './core/settings';
import { getCacheStats } from './core/cache';
import { kkeyStatus } from './sources/direct/kisskh/kkey';
import { kisskhSource } from './sources/direct/kisskh';
import { voirdramaSource } from './sources/direct/voirdrama';
import { nyaaSource } from './sources/torrent/nyaa';
import { torznabSources } from './sources/torrent/torznab';
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

app.listen(PORT, () => {
  console.log(`[Dramallyu] ecoute sur le port ${PORT}`);
  console.log(`[Dramallyu] configuration : http://localhost:${PORT}/configure`);
});

export { app };
