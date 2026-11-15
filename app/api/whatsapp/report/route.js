import { NextResponse } from 'next/server';

import { buildCallSummary } from '@/lib/call-summary';
import { generateCallAnalysis } from '@/lib/call-analysis';
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
    return NextResponse.json(
      { error: 'Invalid request.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const persona = body?.persona && typeof body.persona === 'object' ? body.persona : {};
  const transcript = Array.isArray(body?.transcript) ? body.transcript.slice(0, 200) : [];
  const startedAt = typeof body?.startedAt === 'string' ? body.startedAt : '';
  const durationSeconds = Number(body?.durationSeconds);
  const timeZone = typeof body?.timeZone === 'string' ? body.timeZone : '';
  const callId = typeof body?.callId === 'string' ? body.callId : '';
  const destination = typeof body?.destination === 'string' ? body.destination : '';

  const callAnalysis = await generateCallAnalysis({
    persona,
    transcript,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0
  });

  const summary = buildCallSummary({
    persona,
    transcript,
    startedAt,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    timeZone,
    callId,
    callAnalysis
  });

  try {
    const data = await whatsappRequest(`/sessions/${encodeURIComponent(auth.uid)}/send`, {
      method: 'POST',
      body: { text: summary, to: destination }
    });
    return NextResponse.json(
      { ok: true, messageId: data?.messageId || null },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'Unable to send the call summary.' },
      { status: error?.status || 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
