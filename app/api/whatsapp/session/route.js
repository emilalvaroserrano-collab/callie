import { NextResponse } from 'next/server';

import { verifyFirebaseToken } from '@/lib/verify-token';
import { getWhatsAppConfig, whatsappRequest } from '@/lib/whatsapp-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const config = getWhatsAppConfig();
  if (!config.configured) {
    return NextResponse.json(
      {
        configured: false,
        session: { uid: auth.uid, status: 'unavailable', connected: false },
        error: 'WhatsApp reporting is not configured on the server.'
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const data = await whatsappRequest(`/sessions/${encodeURIComponent(auth.uid)}`);
    return NextResponse.json(
      { ...data, configured: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    const status = error?.status || 502;
    if (status === 404) {
      return NextResponse.json(
        {
          configured: true,
          session: { uid: auth.uid, status: 'disconnected', connected: false }
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
    return NextResponse.json(
      { configured: true, error: error?.message || 'Unable to reach the WhatsApp service.' },
      { status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

export async function POST(request) {
  const auth = await verifyFirebaseToken(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const config = getWhatsAppConfig();
  if (!config.configured) {
    return NextResponse.json(
      { error: 'WhatsApp reporting is not configured on the server.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const action = body?.action || 'connect';
  const encodedUid = encodeURIComponent(auth.uid);

  try {
    if (action === 'logout') {
      const data = await whatsappRequest(`/sessions/${encodedUid}/logout`, { method: 'POST' });
      return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action === 'disconnect') {
      const data = await whatsappRequest(`/sessions/${encodedUid}/disconnect`, { method: 'POST' });
      return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (action === 'connect') {
      const method = body?.method === 'code' ? 'code' : 'qr';
      const phone = typeof body?.phone === 'string' ? body.phone : '';
      const data = await whatsappRequest(`/sessions/${encodedUid}/connect`, {
        method: 'POST',
        body: { method, phone }
      });
      return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(
      { error: 'Unsupported action.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Unable to update the WhatsApp session.' },
      { status: error?.status || 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
