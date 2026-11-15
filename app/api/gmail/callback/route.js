import { NextResponse } from 'next/server';

import { getAdminDb } from '@/lib/firebase-admin';
import { exchangeCode, getProfile, storeTokens } from '@/lib/gmail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state'); // uid
  const error = searchParams.get('error');

  const appUrl = new URL(request.url).origin;

  if (error) {
    return NextResponse.redirect(`${appUrl}/?gmail=error&reason=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/?gmail=error&reason=missing_code`);
  }

  try {
    const tokens = await exchangeCode(code);
    const profile = await getProfile(tokens).catch(() => null);
    const tokenData = storeTokens(null, tokens, profile);

    const db = getAdminDb();
    if (db) {
      await db.ref(`users/${state}/gmail`).set(tokenData);
    }

    return NextResponse.redirect(`${appUrl}/?gmail=connected`);
  } catch (err) {
    return NextResponse.redirect(`${appUrl}/?gmail=error&reason=${encodeURIComponent(err?.message || 'exchange_failed')}`);
  }
}
