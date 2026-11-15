import 'server-only';

import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

let adminApp = null;

export function getAdminApp() {
  if (adminApp) return adminApp;
  if (getApps().length) {
    adminApp = getApps()[0];
    return adminApp;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  if (serviceAccountJson) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson);
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        databaseURL
      });
      return adminApp;
    } catch (error) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', error?.message);
    }
  }

  // Fall back to application default credentials (works on GCP / Vercel with OIDC).
  try {
    adminApp = initializeApp({ databaseURL });
    return adminApp;
  } catch (error) {
    console.error('Firebase admin init failed:', error?.message);
    return null;
  }
}

export function getAdminDb() {
  const app = getAdminApp();
  if (!app) return null;
  return getDatabase(app);
}
