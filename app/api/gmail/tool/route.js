import { NextResponse } from 'next/server';

import { getAdminDb } from '@/lib/firebase-admin';
import {
  deleteMessage,
  getProfile,
  listLabels,
  listMessages,
  readMessage,
  sendEmail,
  trashMessage
} from '@/lib/gmail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function getTokens(uid) {
  const db = getAdminDb();
  if (!db) return null;
  const snap = await db.ref(`users/${uid}/gmail`).get();
  if (!snap.exists()) return null;
  return snap.val();
}

export async function POST(request) {
  const { searchParams } = new URL(request.url);
  const uid = searchParams.get('uid');
  if (!uid) {
    return NextResponse.json({ error: 'Missing uid.' }, { status: 400 });
  }

  const tokens = await getTokens(uid);
  if (!tokens) {
    return NextResponse.json({ result: 'Gmail is not connected for this user.' }, { status: 200 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const toolCall = body?.message?.toolCalls?.[0] || body?.toolCall || body;
  const name = toolCall?.function?.name || toolCall?.name || body?.name;
  const args = toolCall?.function?.arguments
    ? (typeof toolCall.function.arguments === 'string' ? JSON.parse(toolCall.function.arguments) : toolCall.function.arguments)
    : (toolCall?.arguments || body?.arguments || {});

  try {
    let result;
    switch (name) {
      case 'gmail_list_messages':
      case 'gmail_search_messages': {
        const data = await listMessages(tokens, args.query || '', args.maxResults || 10);
        result = data.messages.map((m) => `${m.id} | ${m.from} | ${m.subject} | ${m.date} | ${m.snippet}`).join('\n') || 'No messages found.';
        break;
      }
      case 'gmail_read_message': {
        const m = await readMessage(tokens, args.messageId);
        result = `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body || m.snippet}`;
        break;
      }
      case 'gmail_send_email': {
        const r = await sendEmail(tokens, args.to, args.subject, args.body);
        result = `Email sent successfully. Message ID: ${r.id}`;
        break;
      }
      case 'gmail_delete_message': {
        if (args.permanent) {
          await deleteMessage(tokens, args.messageId);
          result = 'Message permanently deleted.';
        } else {
          await trashMessage(tokens, args.messageId);
          result = 'Message moved to trash.';
        }
        break;
      }
      case 'gmail_list_labels': {
        const labels = await listLabels(tokens);
        result = labels.map((l) => `${l.id}: ${l.name}`).join('\n') || 'No labels.';
        break;
      }
      case 'gmail_get_profile': {
        const profile = await getProfile(tokens);
        result = `Email: ${profile.email}\nTotal messages: ${profile.messagesTotal}\nTotal threads: ${profile.threadsTotal}`;
        break;
      }
      default:
        result = `Unknown tool: ${name}`;
    }

    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ result: `Error: ${err?.message || 'Unknown error'}` });
  }
}
