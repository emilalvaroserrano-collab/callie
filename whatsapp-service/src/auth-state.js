import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const UID_RE = /^[A-Za-z0-9_-]{6,128}$/;

export function isValidUid(uid) {
  return typeof uid === 'string' && UID_RE.test(uid);
}

export function authDirFor(uid) {
  return path.join(config.authDir, uid);
}

export async function hasStoredAuth(uid) {
  try {
    await fs.access(path.join(authDirFor(uid), 'creds.json'));
    return true;
  } catch {
    return false;
  }
}

export async function readStoredCreds(uid) {
  try {
    const raw = await fs.readFile(path.join(authDirFor(uid), 'creds.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function removeStoredAuth(uid) {
  try {
    await fs.rm(authDirFor(uid), { recursive: true, force: true });
  } catch {}
}

export async function listStoredUids() {
  try {
    const entries = await fs.readdir(config.authDir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidUid(entry.name)) continue;
      if (await hasStoredAuth(entry.name)) result.push(entry.name);
    }
    return result;
  } catch {
    return [];
  }
}

export async function ensureAuthRoot() {
  await fs.mkdir(config.authDir, { recursive: true });
}
