import { NextResponse } from 'next/server';

import { verifyFirebaseToken } from '@/lib/verify-token';
import { getGoogleConfig } from '@/lib/gmail';
import { getAdminDb } from '@/lib/firebase-admin';

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

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json({ configured: true, connected: false, error: 'Server database not configured.' });
  }
  const snap = await db.ref(`users/${auth.uid}/gmail`).get();
  if (!snap.exists()) {
    return NextResponse.json({ configured: true, connected: false });
  }
  const data = snap.val();
  return NextResponse.json({ configured: true, connected: true, email: data?.email || '' });
}
