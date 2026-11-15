import fs from 'node:fs';

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

const rootDir = new URL('..', import.meta.url);
loadDotEnv(new URL('.env', rootDir));

const required = [];
const env = (name) => {
  const value = process.env[name] ?? process.env[`NEXT_PUBLIC_${name}`];
  if (value === undefined || value === '') {
    required.push(name);
    return '';
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

const configSource = `window.APP_CONFIG = ${JSON.stringify(config, null, 2)};\n`;

/* Root copy keeps local file:// / static previews working. */
fs.writeFileSync(new URL('config.js', rootDir), configSource);

/* Only files placed in public/ are uploaded and served by Vercel. */
const publicDir = new URL('public/', rootDir);
fs.mkdirSync(publicDir, { recursive: true });
for (const file of ['index.html', 'auth.html']) {
  fs.copyFileSync(new URL(file, rootDir), new URL(file, publicDir));
}
fs.writeFileSync(new URL('config.js', publicDir), configSource);

console.log('Generated config.js and public/ build output from environment variables.');
