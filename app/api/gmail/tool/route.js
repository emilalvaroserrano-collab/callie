import { NextResponse } from 'next/server';

import { getAdminDb } from '@/lib/firebase-admin';
import {
  calendarCreateEvent,
  calendarDeleteEvent,
  calendarListCalendars,
  calendarListEvents,
  contactsCreate,
  contactsDelete,
  contactsList,
  deleteMessage,
  docsAppendText,
  docsCreate,
  docsRead,
  driveCreateFolder,
  driveDeleteFile,
  driveGetFile,
  driveListFiles,
  driveSearchFiles,
  getProfile,
  listLabels,
  listMessages,
  readMessage,
  sendEmail,
  sheetsAppend,
  sheetsCreate,
  sheetsRead,
  sheetsWrite,
  slidesCreate,
  slidesRead,
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
      // ===== Google Drive =====
      case 'drive_list_files': {
        const files = await driveListFiles(tokens, args.query || '', args.maxResults || 20);
        result = files.map((f) => `${f.id} | ${f.name} | ${f.mimeType} | ${f.modifiedTime}`).join('\\n') || 'No files found.';
        break;
      }
      case 'drive_search_files': {
        const files = await driveSearchFiles(tokens, args.query || '', args.maxResults || 20);
        result = files.map((f) => `${f.id} | ${f.name} | ${f.mimeType}`).join('\\n') || 'No files found.';
        break;
      }
      case 'drive_get_file': {
        const f = await driveGetFile(tokens, args.fileId);
        result = `ID: ${f.id}\\nName: ${f.name}\\nType: ${f.mimeType}\\nModified: ${f.modifiedTime}\\nLink: ${f.webViewLink}`;
        break;
      }
      case 'drive_create_folder': {
        const f = await driveCreateFolder(tokens, args.name, args.parentId);
        result = `Folder created. ID: ${f.id}, Name: ${f.name}`;
        break;
      }
      case 'drive_delete_file': {
        await driveDeleteFile(tokens, args.fileId);
        result = 'File deleted.';
        break;
      }
      // ===== Google Sheets =====
      case 'sheets_create': {
        const r = await sheetsCreate(tokens, args.title);
        result = `Spreadsheet created. ID: ${r.spreadsheetId}\\nURL: ${r.url}`;
        break;
      }
      case 'sheets_read': {
        const values = await sheetsRead(tokens, args.spreadsheetId, args.range);
        result = values.map((row) => row.join(' | ')).join('\\n') || 'Empty range.';
        break;
      }
      case 'sheets_write': {
        const r = await sheetsWrite(tokens, args.spreadsheetId, args.range, args.values);
        result = `Updated ${r.updatedCells} cells in ${r.updatedRange}.`;
        break;
      }
      case 'sheets_append': {
        const r = await sheetsAppend(tokens, args.spreadsheetId, args.range, args.values);
        result = `Appended ${r.updatedCells} cells.`;
        break;
      }
      // ===== Google Docs =====
      case 'docs_create': {
        const d = await docsCreate(tokens, args.title);
        result = `Document created. ID: ${d.documentId}, Title: ${d.title}`;
        break;
      }
      case 'docs_read': {
        const d = await docsRead(tokens, args.documentId);
        result = `Title: ${d.title}\\n\\n${d.text}`;
        break;
      }
      case 'docs_append_text': {
        await docsAppendText(tokens, args.documentId, args.text);
        result = 'Text appended to document.';
        break;
      }
      // ===== Google Slides =====
      case 'slides_create': {
        const p = await slidesCreate(tokens, args.title);
        result = `Presentation created. ID: ${p.presentationId}, Title: ${p.title}`;
        break;
      }
      case 'slides_read': {
        const p = await slidesRead(tokens, args.presentationId);
        result = `Title: ${p.title}\\n\\n${(p.slides || []).join('\\n')}`;
        break;
      }
      // ===== Google Calendar =====
      case 'calendar_list_events': {
        const events = await calendarListEvents(tokens, args.calendarId || 'primary', args.maxResults || 10, args.timeMin);
        result = events.map((e) => `${e.id} | ${e.summary} | ${e.start} → ${e.end} | ${e.location || ''}`).join('\\n') || 'No events.';
        break;
      }
      case 'calendar_create_event': {
        const e = await calendarCreateEvent(tokens, args.calendarId || 'primary', {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: { dateTime: args.start, timeZone: args.timeZone || 'UTC' },
          end: { dateTime: args.end, timeZone: args.timeZone || 'UTC' }
        });
        result = `Event created. ID: ${e.id}, Summary: ${e.summary}\\nLink: ${e.htmlLink}`;
        break;
      }
      case 'calendar_delete_event': {
        await calendarDeleteEvent(tokens, args.calendarId || 'primary', args.eventId);
        result = 'Event deleted.';
        break;
      }
      case 'calendar_list_calendars': {
        const cals = await calendarListCalendars(tokens);
        result = cals.map((c) => `${c.id} | ${c.summary}${c.primary ? ' (primary)' : ''}`).join('\\n');
        break;
      }
      // ===== Google Contacts =====
      case 'contacts_list': {
        const contacts = await contactsList(tokens, args.pageSize || 20);
        result = contacts.map((c) => `${c.resourceName} | ${c.name} | ${c.email} | ${c.phone}`).join('\\n') || 'No contacts.';
        break;
      }
      case 'contacts_create': {
        const c = await contactsCreate(tokens, args.name, args.email, args.phone);
        result = `Contact created. ${c.name} (${c.resourceName})`;
        break;
      }
      case 'contacts_delete': {
        await contactsDelete(tokens, args.resourceName);
        result = 'Contact deleted.';
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
