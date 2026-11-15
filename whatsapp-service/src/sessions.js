import { promises as fs } from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  authDirFor,
  hasStoredAuth,
  isValidUid,
  listStoredUids,
  readStoredCreds,
  removeStoredAuth
} from './auth-state.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sessions = new Map();
const timers = new Map();

function now() {
  return new Date().toISOString();
}

function sanitizePhone(value) {
  if (typeof value !== 'string') return '';
  let digits = value.replace(/[^\d]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits;
}

function createRecord(uid) {
  return {
    uid,
    status: 'idle',
    connected: false,
    phone: null,
    name: null,
    jid: null,
    qr: null,
    qrUpdatedAt: null,
    pairingCode: null,
    pairingPhone: null,
    pairingUpdatedAt: null,
    lastError: null,
    reconnectAttempts: 0,
    startedAt: now(),
    updatedAt: now(),
    socket: null,
    saveCreds: null,
    generation: 0,
    readyResolve: null,
    readyReject: null,
    readyPromise: null,
    pendingPairing: null,
    stopping: false
  };
}

function getOrCreate(uid) {
  if (!isValidUid(uid)) throw new HttpError(400, 'Invalid session id.');
  let record = sessions.get(uid);
  if (!record) {
    if (sessions.size >= config.maxSessions) throw new HttpError(429, 'Session limit reached.');
    record = createRecord(uid);
    sessions.set(uid, record);
  }
  return record;
}

function touch(record) {
  record.updatedAt = now();
}

function clearReconnect(uid) {
  const timer = timers.get(uid);
  if (timer) {
    clearTimeout(timer);
    timers.delete(uid);
  }
}

function setReady(record, value, error) {
  if (!record.readyResolve) return;
  if (error) {
    try { record.readyReject?.(error); } catch {}
  } else {
    try { record.readyResolve(value); } catch {}
  }
  record.readyResolve = null;
  record.readyReject = null;
  record.readyPromise = null;
}

function snapshot(record) {
  return {
    uid: record.uid,
    status: record.status,
    connected: record.connected,
    phone: record.phone,
    name: record.name,
    qr: record.qr,
    qrUpdatedAt: record.qrUpdatedAt,
    pairingCode: record.pairingCode,
    pairingPhone: record.pairingPhone,
    pairingUpdatedAt: record.pairingUpdatedAt,
    lastError: record.lastError,
    reconnectAttempts: record.reconnectAttempts,
    updatedAt: record.updatedAt
  };
}

function setDisconnected(record, code, error) {
  record.connected = false;
  record.socket = null;
  record.saveCreds = null;
  record.jid = null;
  record.status = 'disconnected';
  if (code === DisconnectReason.loggedOut) {
    record.phone = null;
    record.name = null;
    record.qr = null;
    record.pairingCode = null;
    record.lastError = null;
  } else {
    record.lastError = error?.message || `Connection closed (${code ?? 'unknown'}).`;
  }
  touch(record);
}

async function startSocket(record, mode, phoneDigits) {
  if (record.socket) {
    try { record.socket.end?.(undefined); } catch {}
    record.socket = null;
  }
  clearReconnect(record.uid);
  const timersToClear = [...timers.keys()].filter((key) => key.startsWith(record.uid + ':'));
  timersToClear.forEach((key) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
  });

  record.generation += 1;
  const generation = record.generation;
  record.status = 'connecting';
  record.lastError = null;
  record.qr = null;
  record.qrUpdatedAt = null;
  record.pairingCode = null;
  record.pairingUpdatedAt = null;
  touch(record);

  const authDir = authDirFor(record.uid);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  record.saveCreds = saveCreds;

  let version;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched?.version;
  } catch (error) {
    logger.warn({ uid: record.uid, err: error?.message }, 'Could not fetch Baileys version');
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: logger.child({ uid: record.uid }),
    browser: Browsers.ubuntu('CSR Studio'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined
  });
  record.socket = sock;

  sock.ev.on('creds.update', () => {
    if (record.generation !== generation) return;
    saveCreds().catch((error) => {
      logger.warn({ uid: record.uid, err: error?.message }, 'Failed to save creds');
    });
  });

  sock.ev.on('connection.update', (update) => {
    if (record.generation !== generation) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (mode === 'code') {
        // Pairing-code flow takes priority; ignore QR until the code arrives.
        touch(record);
        return;
      }
      record.status = 'awaiting_qr';
      QRCode.toDataURL(qr, { width: 320, margin: 1, color: { dark: '#0b1326', light: '#ffffff' } })
        .then((dataUrl) => {
          if (record.generation !== generation) return;
          record.qr = dataUrl;
          record.qrUpdatedAt = now();
          touch(record);
          setReady(record, snapshot(record));
        })
        .catch((error) => {
          logger.warn({ uid: record.uid, err: error?.message }, 'QR render failed');
        });
      touch(record);
    }

    if (connection === 'open') {
      record.status = 'connected';
      record.connected = true;
      record.qr = null;
      record.qrUpdatedAt = null;
      record.pairingCode = null;
      record.pairingUpdatedAt = null;
      record.lastError = null;
      record.reconnectAttempts = 0;
      const user = sock.user;
      record.jid = user?.id || null;
      record.phone = user?.id ? user.id.split(':')[0].replace(/[^\d]/g, '') : null;
      record.name = user?.name || user?.verifiedName || null;
      touch(record);
      setReady(record, snapshot(record));
    }

    if (connection === 'close') {
      const boom = lastDisconnect?.error;
      const statusCode = boom?.output?.statusCode ?? boom?.statusCode;
      const message = boom?.message || 'Connection closed.';
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const shouldReconnect = !loggedOut && !record.stopping;

      setDisconnected(record, statusCode, loggedOut ? null : new Error(message));
      record.status = 'disconnected';

      if (loggedOut) {
        removeStoredAuth(record.uid).catch(() => {});
      }

      if (shouldReconnect) {
        record.reconnectAttempts += 1;
        const delay = Math.min(
          config.reconnectMaxMs,
          config.reconnectBaseMs * Math.pow(2, Math.min(record.reconnectAttempts, 6))
        );
        const timer = setTimeout(() => {
          timers.delete(record.uid);
          startSession(record.uid, 'qr').catch((error) => {
            logger.warn({ uid: record.uid, err: error?.message }, 'Reconnect failed');
          });
        }, delay);
        timers.set(record.uid, timer);
      }

      if (record.readyResolve) {
        setReady(record, null, new Error(message));
      }
    }
  });

  if (mode === 'code' && phoneDigits && !state.creds.registered) {
    record.pendingPairing = phoneDigits;
    const attemptPairing = async (attempt = 0) => {
      if (record.generation !== generation || record.status === 'connected') return;
      try {
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200));
        const code = await sock.requestPairingCode(phoneDigits);
        if (record.generation !== generation) return;
        record.pairingCode = code;
        record.pairingPhone = phoneDigits;
        record.pairingUpdatedAt = now();
        record.status = 'awaiting_code';
        touch(record);
        setReady(record, snapshot(record));
      } catch (error) {
        if (record.generation !== generation) return;
        if (attempt < 6) {
          const t = setTimeout(() => attemptPairing(attempt + 1), 1500);
          timers.set(record.uid + ':pair', t);
        } else {
          record.lastError = error?.message || 'Could not generate a pairing code.';
          record.status = 'error';
          touch(record);
          setReady(record, null, new Error(record.lastError));
        }
      }
    };
    attemptPairing().catch(() => {});
  }
}

export async function startSession(uid, mode = 'qr', phone = null) {
  const record = getOrCreate(uid);
  const phoneDigits = sanitizePhone(phone);

  if (record.connected) {
    touch(record);
    return snapshot(record);
  }

  if (record.status === 'connecting' || record.status === 'awaiting_qr' || record.status === 'awaiting_code') {
    if (mode === 'code' && record.status === 'awaiting_qr') {
      await stopSession(uid, false);
      return startSession(uid, mode, phone);
    }
    if (mode === 'qr' && record.status === 'awaiting_code') {
      await stopSession(uid, false);
      return startSession(uid, mode, phone);
    }
    if (record.readyPromise) return record.readyPromise;
  }

  if (mode === 'code') {
    if (!phoneDigits || phoneDigits.length < 7 || phoneDigits.length > 15) {
      throw new HttpError(400, 'Enter a valid WhatsApp number with country code.');
    }
  }

  clearReconnect(uid);

  record.readyPromise = new Promise((resolve, reject) => {
    record.readyResolve = resolve;
    record.readyReject = reject;
  });

  const timeout = setTimeout(() => {
    if (record.readyResolve) {
      setReady(record, null, new HttpError(504, 'Timed out while preparing WhatsApp. Please retry.'));
    }
  }, 45000);

  try {
    await startSocket(record, mode, phoneDigits);
    const result = await record.readyPromise;
    return result;
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(500, error?.message || 'Unable to start WhatsApp session.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function stopSession(uid, logout = false) {
  const record = sessions.get(uid);
  if (!record) return;
  record.stopping = true;
  clearReconnect(uid);
  [...timers.keys()].filter((k) => k.startsWith(uid)).forEach((k) => {
    clearTimeout(timers.get(k));
    timers.delete(k);
  });

  if (record.socket) {
    try {
      if (logout) await record.socket.logout();
      else record.socket.end?.(undefined);
    } catch (error) {
      logger.warn({ uid, err: error?.message }, 'Socket stop error');
    }
  }
  record.socket = null;
  record.saveCreds = null;

  if (logout) {
    await removeStoredAuth(uid);
    record.status = 'disconnected';
    record.connected = false;
    record.phone = null;
    record.name = null;
    record.jid = null;
    record.qr = null;
    record.qrUpdatedAt = null;
    record.pairingCode = null;
    record.pairingPhone = null;
    record.pairingUpdatedAt = null;
    record.lastError = null;
    record.reconnectAttempts = 0;
  } else {
    record.status = 'disconnected';
    record.connected = false;
    record.qr = null;
    record.qrUpdatedAt = null;
    record.pairingCode = null;
    record.pairingPhone = null;
    record.pairingUpdatedAt = null;
  }
  record.stopping = false;
  touch(record);
  setReady(record, null, new HttpError(499, 'Cancelled.'));
}

export function getSession(uid) {
  const record = sessions.get(uid);
  if (!record) return null;
  touch(record);
  return snapshot(record);
}

export async function getSessionWithRestore(uid) {
  if (!isValidUid(uid)) return null;
  let record = sessions.get(uid);
  if (!record) {
    if (!(await hasStoredAuth(uid))) return null;
    record = getOrCreate(uid);
  }
  if (record.status === 'idle' && (await hasStoredAuth(uid))) {
    try {
      await startSession(uid, 'qr');
    } catch {
      // Fall through to snapshot.
    }
  }
  const current = sessions.get(uid);
  return current ? snapshot(current) : null;
}

export async function sendMessage(uid, text, to) {
  const record = sessions.get(uid);
  if (!record || !record.connected || !record.socket) {
    throw new HttpError(409, 'WhatsApp is not connected. Please connect first.');
  }
  const message = (text || '').trim();
  if (!message) throw new HttpError(400, 'Message text is required.');
  if (message.length > 10000) throw new HttpError(400, 'Message is too long.');

  let jid;
  const destination = sanitizePhone(to);
  if (destination) {
    if (destination.length < 7 || destination.length > 15) {
      throw new HttpError(400, 'Enter a valid destination number with country code.');
    }
    jid = `${destination}@s.whatsapp.net`;
  } else {
    if (!record.phone) throw new HttpError(409, 'Connected account number is unavailable.');
    jid = record.jid || `${record.phone}@s.whatsapp.net`;
  }

  try {
    const result = await record.socket.sendMessage(jid, { text: message });
    touch(record);
    return { messageId: result?.key?.id || null };
  } catch (error) {
    throw new HttpError(502, error?.message || 'Unable to send the WhatsApp message.');
  }
}

export async function restoreAll() {
  const uids = await listStoredUids();
  for (const uid of uids) {
    try {
      const creds = await readStoredCreds(uid);
      if (!creds?.registered) continue;
      await startSession(uid, 'qr').catch((error) => {
        logger.warn({ uid, err: error?.message }, 'Restore failed');
      });
    } catch (error) {
      logger.warn({ uid, err: error?.message }, 'Restore skipped');
    }
  }
}

export async function shutdownAll() {
  for (const uid of [...sessions.keys()]) {
    try { await stopSession(uid, false); } catch {}
  }
}

export function serviceSnapshot() {
  return {
    sessions: sessions.size,
    connected: [...sessions.values()].filter((r) => r.connected).length
  };
}
