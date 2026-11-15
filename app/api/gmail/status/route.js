import { NextResponse } from 'next/server';

import { verifyFirebaseToken } from '@/lib/verify-token';
import { getGoogleConfig } from '@/lib/gmail';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getDatabase, ref, get } from 'firebase/database';
import { getFirebaseConfig } from '@/lib/server-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const config = getGoogleConfig();
  if (!config.configured) {
    return NextResponse.json({ configured: false, connected: false });
  }

  const firebaseConfig = getFirebaseConfig();
  const fbApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const db = getDatabase(fbApp);
  const snap = await get(ref(db, `users/${auth.uid}/gmail`));
  if (!snap.exists()) {
    return NextResponse.json({ configured: true, connected: false });
  }
  const data = snap.val();
  return NextResponse.json({ configured: true, connected: true, email: data?.email || '' });
}
