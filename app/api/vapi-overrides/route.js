import { NextResponse } from 'next/server';

import { buildOverrides } from '@/lib/agent-overrides';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function hasValidSession(request) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) return false;

  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return false;

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
        cache: 'no-store'
      }
    );
    if (!response.ok) return false;
    const data = await response.json();
    return Array.isArray(data?.users) && data.users.length > 0;
  } catch (error) {
    return false;
  }
}

export async function POST(request) {
  if (!(await hasValidSession(request))) {
    return NextResponse.json(
      { error: 'Your session could not be verified. Please sign in again.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
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
