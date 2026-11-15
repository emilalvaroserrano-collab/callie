import path from 'node:path';

const authDir = path.resolve(process.env.AUTH_DIR || './data/auth');

export const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  authDir,
  secret: process.env.WHATSAPP_SERVICE_SECRET || '',
  logLevel: process.env.LOG_LEVEL || 'warn',
  maxSessions: Number(process.env.MAX_SESSIONS || 250),
  reconnectBaseMs: Number(process.env.RECONNECT_BASE_MS || 1500),
  reconnectMaxMs: Number(process.env.RECONNECT_MAX_MS || 60000)
};
