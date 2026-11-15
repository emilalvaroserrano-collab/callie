import { NextResponse } from 'next/server';

import { verifyFirebaseToken } from '@/lib/verify-token';
import { getWhatsAppConfig, whatsappRequest } from '@/lib/whatsapp-service';

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

  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return NextResponse.json(
      { error: 'Message text is required.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  try {
    const data = await whatsappRequest(`/sessions/${encodeURIComponent(auth.uid)}/send`, {
      method: 'POST',
      body: { text, to: typeof body?.to === 'string' ? body.to : '' }
    });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Unable to send the WhatsApp message.' },
      { status: error?.status || 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
