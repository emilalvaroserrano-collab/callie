import { NextResponse } from 'next/server';

import { verifyFirebaseToken } from '@/lib/verify-token';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getDatabase, ref, remove } from 'firebase/database';
import { getFirebaseConfig } from '@/lib/server-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const firebaseConfig = getFirebaseConfig();
  const fbApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const db = getDatabase(fbApp);
  await remove(ref(db, `users/${auth.uid}/gmail`));
  return NextResponse.json({ ok: true });
}
