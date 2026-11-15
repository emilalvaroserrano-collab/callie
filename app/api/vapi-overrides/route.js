import { NextResponse } from 'next/server';

import { buildOverrides } from '@/lib/agent-overrides';
import { verifyFirebaseToken } from '@/lib/verify-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid request.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // Check Gmail connection status for this user.
  let gmailConnected = false;
  let gmailEmail = '';
  try {
    const { getApp, getApps, initializeApp } = await import('firebase/app');
    const { getDatabase, ref, get } = await import('firebase/database');
    const { getFirebaseConfig } = await import('@/lib/server-config');
    const firebaseConfig = getFirebaseConfig();
    const fbApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const db = getDatabase(fbApp);
    const snap = await get(ref(db, `users/${auth.uid}/gmail`));
    if (snap.exists()) {
      gmailConnected = true;
      gmailEmail = snap.val()?.email || '';
    }
  } catch (error) {}

  body = { ...body, gmailConnected, gmailEmail, uid: auth.uid };

  try {
    const overrides = buildOverrides(body);
    return NextResponse.json(
      { overrides },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Unable to build the voice configuration.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
