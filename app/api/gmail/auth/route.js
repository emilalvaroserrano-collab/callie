import { NextResponse } from 'next/server';

import { verifyFirebaseToken } from '@/lib/verify-token';
import { buildAuthUrl, getGoogleConfig } from '@/lib/gmail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  // Accept the Firebase ID token from the query string (browser navigation) or Authorization header.
  const { searchParams } = new URL(request.url);
  const queryToken = searchParams.get('token');
  let auth;
  if (queryToken) {
    const fakeRequest = new Request(request.url, {
      headers: { authorization: `Bearer ${queryToken}` }
    });
    auth = await verifyFirebaseToken(fakeRequest);
  } else {
    auth = await verifyFirebaseToken(request);
  }

  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const config = getGoogleConfig();
  if (!config.configured) {
    return NextResponse.json(
      { error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.' },
      { status: 503 }
    );
  }

  const url = buildAuthUrl(auth.uid);
  if (!url) {
    return NextResponse.json({ error: 'Unable to build auth URL.' }, { status: 500 });
  }
  return NextResponse.redirect(url);
}
