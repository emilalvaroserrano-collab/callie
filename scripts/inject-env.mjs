import fs from 'node:fs';
import path from 'node:path';

/* Load a local .env file when present (Vercel injects env vars directly). */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(new URL('../.env', import.meta.url));

const required = [];
const env = (name, fallback = '') => {
  const value = process.env[name] ?? process.env[`NEXT_PUBLIC_${name}`];
  if (value === undefined || value === '') {
    if (fallback === '') required.push(name);
    return fallback;
  }
  return value;
};

const config = {
  firebase: {
    apiKey: env('FIREBASE_API_KEY'),
    authDomain: env('FIREBASE_AUTH_DOMAIN'),
    databaseURL: env('FIREBASE_DATABASE_URL'),
    projectId: env('FIREBASE_PROJECT_ID'),
    storageBucket: env('FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: env('FIREBASE_MESSAGING_SENDER_ID'),
    appId: env('FIREBASE_APP_ID'),
    measurementId: env('FIREBASE_MEASUREMENT_ID'),
  },
  vapi: {
    publicKey: env('VAPI_PUBLIC_KEY'),
    assistantId: env('VAPI_ASSISTANT_ID'),
  },
};

if (required.length) {
  console.error(
    '\nMissing environment variables: ' + required.join(', ') +
    '\nAdd them in Vercel → Project → Settings → Environment Variables, or in a local .env file.\n'
  );
  process.exit(1);
}

const out = `window.APP_CONFIG = ${JSON.stringify(config, null, 2)};\n`;
const target = new URL('../config.js', import.meta.url);
fs.writeFileSync(target, out);
console.log('Generated ' + path.basename(target.pathname) + ' from environment variables.');
