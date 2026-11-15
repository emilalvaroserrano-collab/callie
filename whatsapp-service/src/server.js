import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { ensureAuthRoot } from './auth-state.js';
import {
  HttpError,
  getSession,
  getSessionWithRestore,
  sendMessage,
  serviceSnapshot,
  shutdownAll,
  startSession,
  stopSession,
  restoreAll
} from './sessions.js';

if (!config.secret || config.secret.length < 16) {
  logger.error('WHATSAPP_SERVICE_SECRET is missing or too short. Refusing to start.');
  process.exit(1);
}

await ensureAuthRoot();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a || '')).digest();
  const right = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function auth(req, res, next) {
  const provided = req.get('x-service-secret') || '';
  if (!safeEqual(provided, config.secret)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireUid(req) {
  const uid = req.params.uid;
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) {
    throw new HttpError(400, 'Invalid session id.');
  }
  return uid;
}

app.get('/', (req, res) => {
  res.type('text/plain').send('WhatsApp Server Running Successfully');
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ...serviceSnapshot() });
});

app.get('/sessions/:uid', auth, asyncRoute(async (req, res) => {
  const uid = requireUid(req);
  let session = getSession(uid);
  if (!session) {
    try {
      session = await getSessionWithRestore(uid);
    } catch {
      session = null;
    }
  }
  if (!session) return res.status(404).json({ error: 'No WhatsApp session for this account.' });
  res.json({ configured: true, session });
}));

app.post('/sessions/:uid/connect', auth, asyncRoute(async (req, res) => {
  const uid = requireUid(req);
  const method = req.body?.method === 'code' ? 'code' : 'qr';
  const phone = typeof req.body?.phone === 'string' ? req.body.phone : '';
  const session = await startSession(uid, method, phone);
  res.json({ configured: true, session });
}));

app.post('/sessions/:uid/disconnect', auth, asyncRoute(async (req, res) => {
  const uid = requireUid(req);
  await stopSession(uid, false);
  const session = getSession(uid);
  res.json({ configured: true, session: session || { uid, status: 'disconnected', connected: false } });
}));

app.post('/sessions/:uid/logout', auth, asyncRoute(async (req, res) => {
  const uid = requireUid(req);
  await stopSession(uid, true);
  const session = getSession(uid);
  res.json({ configured: true, session: session || { uid, status: 'disconnected', connected: false } });
}));

app.post('/sessions/:uid/send', auth, asyncRoute(async (req, res) => {
  const uid = requireUid(req);
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const to = typeof req.body?.to === 'string' ? req.body.to : '';
  const result = await sendMessage(uid, text, to);
  res.json({ ok: true, ...result });
}));

app.use((error, req, res, next) => {
  const status = error?.status || 500;
  const message = error?.message || 'Internal server error.';
  if (status >= 500) logger.error({ err: message, path: req.path }, 'Request failed');
  res.status(status).json({ error: message });
});

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'WhatsApp service listening');
});

restoreAll().catch((error) => logger.warn({ err: error?.message }, 'Restore failed'));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  server.close();
  try { await shutdownAll(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error({ err: error?.message, stack: error?.stack }, 'Uncaught exception');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'Unhandled rejection');
});
