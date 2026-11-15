import fs from 'node:fs';

const env = (name, fallback = '') => process.env[name] ?? process.env[`NEXT_PUBLIC_${name}`] ?? fallback;

const config = {
  firebase: {
    apiKey: env('FIREBASE_API_KEY', 'AIzaSyCHErUyhBxmwFpKJ4b7QaRmEYaiLm-rjDA'),
    authDomain: env('FIREBASE_AUTH_DOMAIN', 'csr-studio.firebaseapp.com'),
    databaseURL: env('FIREBASE_DATABASE_URL', 'https://csr-studio-default-rtdb.firebaseio.com'),
    projectId: env('FIREBASE_PROJECT_ID', 'csr-studio'),
    storageBucket: env('FIREBASE_STORAGE_BUCKET', 'csr-studio.firebasestorage.app'),
    messagingSenderId: env('FIREBASE_MESSAGING_SENDER_ID', '990796119326'),
    appId: env('FIREBASE_APP_ID', '1:990796119326:web:f4a3df85569d4bd7e89d0f'),
    measurementId: env('FIREBASE_MEASUREMENT_ID', 'G-4YDHQGKD3P'),
  },
  vapi: {
    publicKey: env('VAPI_PUBLIC_KEY', '190d2ce6-d586-43e1-ab9c-fa2f8f911680'),
    assistantId: env('VAPI_ASSISTANT_ID', '88765083-33f2-4398-936b-1b7ec947deff'),
  },
};

const out = `window.APP_CONFIG = ${JSON.stringify(config, null, 2)};\n`;
fs.writeFileSync(new URL('../config.js', import.meta.url), out);
console.log('Generated config.js from environment variables.');
