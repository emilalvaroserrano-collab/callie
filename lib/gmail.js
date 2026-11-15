import 'server-only';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/userinfo.email'
];

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || '';
  return { clientId, clientSecret, redirectUri, configured: Boolean(clientId && clientSecret && redirectUri) };
}

export function buildAuthUrl(uid) {
  const config = getGoogleConfig();
  if (!config.configured) return null;
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: uid
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCode(code) {
  const config = getGoogleConfig();
  if (!config.configured) throw new Error('Google OAuth is not configured.');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code'
    }).toString()
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error_description || data?.error || 'Token exchange failed.');
  return data;
}

export async function refreshAccessToken(refreshToken) {
  const config = getGoogleConfig();
  if (!config.configured) throw new Error('Google OAuth is not configured.');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token'
    }).toString()
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error_description || data?.error || 'Token refresh failed.');
  return data;
}

async function getValidAccessToken(tokens) {
  if (!tokens) throw new Error('Gmail is not connected.');
  const now = Date.now();
  if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt > now + 60000) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken) throw new Error('Gmail session expired. Please reconnect.');
  const refreshed = await refreshAccessToken(tokens.refreshToken);
  return refreshed.access_token;
}

async function gmailFetch(tokens, path, options = {}) {
  const accessToken = await getValidAccessToken(tokens);
  const response = await fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!response.ok) {
    throw new Error(data?.error?.message || `Gmail API error (${response.status}).`);
  }
  return data;
}

export async function getProfile(tokens) {
  const data = await gmailFetch(tokens, '/profile');
  return { email: data.emailAddress, messagesTotal: data.messagesTotal, threadsTotal: data.threadsTotal };
}

export async function listMessages(tokens, query = '', maxResults = 10) {
  const params = new URLSearchParams({ maxResults: String(Math.min(maxResults, 50)) });
  if (query) params.set('q', query);
  const data = await gmailFetch(tokens, `/messages?${params.toString()}`);
  const messages = data.messages || [];
  const details = await Promise.all(
    messages.slice(0, maxResults).map(async (m) => {
      try {
        const full = await gmailFetch(tokens, `/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
        const headers = full.payload?.headers || [];
        const get = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
        return {
          id: m.id,
          threadId: m.threadId,
          subject: get('Subject'),
          from: get('From'),
          date: get('Date'),
          snippet: full.snippet || ''
        };
      } catch {
        return { id: m.id, threadId: m.threadId, subject: '', from: '', date: '', snippet: '' };
      }
    })
  );
  return { messages: details, resultSizeEstimate: data.resultSizeEstimate || details.length };
}

export async function readMessage(tokens, messageId) {
  const data = await gmailFetch(tokens, `/messages/${encodeURIComponent(messageId)}?format=full`);
  const headers = data.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  let body = '';
  function extract(part) {
    if (!part) return;
    if (part.body?.data) {
      try { body += Buffer.from(part.body.data, 'base64').toString('utf8'); } catch {}
    }
    if (part.parts) part.parts.forEach(extract);
  }
  extract(data.payload);
  return {
    id: data.id,
    threadId: data.threadId,
    subject: get('Subject'),
    from: get('From'),
    to: get('To'),
    date: get('Date'),
    snippet: data.snippet || '',
    body: body.slice(0, 4000)
  };
}

export async function sendEmail(tokens, to, subject, body) {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body
  ].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const data = await gmailFetch(tokens, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: encoded })
  });
  return { id: data.id, threadId: data.threadId };
}

export async function deleteMessage(tokens, messageId) {
  await gmailFetch(tokens, `/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
  return { deleted: true };
}

export async function trashMessage(tokens, messageId) {
  const data = await gmailFetch(tokens, `/messages/${encodeURIComponent(messageId)}/trash`, { method: 'POST' });
  return { id: data.id, trashed: true };
}

export async function listLabels(tokens) {
  const data = await gmailFetch(tokens, '/labels');
  return (data.labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
}

export function storeTokens(userRef, tokens, profile) {
  // returns the object to save
  const now = Date.now();
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresAt: now + (tokens.expires_in || 3600) * 1000,
    scope: tokens.scope || '',
    email: profile?.email || '',
    connectedAt: now
  };
}

// ===== Google Drive =====
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export async function driveListFiles(tokens, query = '', maxResults = 20) {
  const params = new URLSearchParams({ pageSize: String(Math.min(maxResults, 50)), fields: 'files(id,name,mimeType,modifiedTime,size)' });
  if (query) params.set('q', query);
  const data = await gmailFetch(tokens, `/../drive/v3/files?${params.toString()}`).catch(async () => {
    const r = await fetch(`${DRIVE_API}/files?${params.toString()}`, { headers: { Authorization: `Bearer ${await getValidAccessToken(tokens)}` } });
    return r.json();
  });
  // Use direct fetch instead
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${DRIVE_API}/files?${params.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Drive list failed.');
  return (d.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: f.size }));
}

export async function driveGetFile(tokens, fileId) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,size,webViewLink`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Drive get failed.');
  return d;
}

export async function driveCreateFolder(tokens, name, parentId) {
  const accessToken = await getValidAccessToken(tokens);
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const res = await fetch(`${DRIVE_API}/files`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Drive create folder failed.');
  return d;
}

export async function driveDeleteFile(tokens, fileId) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok && res.status !== 204) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d?.error?.message || 'Drive delete failed.');
  }
  return { deleted: true };
}

export async function driveSearchFiles(tokens, query, maxResults = 20) {
  return driveListFiles(tokens, `name contains '${query.replace(/'/g, "\\'")}'`, maxResults);
}

// ===== Google Sheets =====
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function sheetsCreate(tokens, title) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(SHEETS_API, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ properties: { title } }) });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Sheets create failed.');
  return { spreadsheetId: d.spreadsheetId, url: d.spreadsheetUrl };
}

export async function sheetsRead(tokens, spreadsheetId, range) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Sheets read failed.');
  return d.values || [];
}

export async function sheetsWrite(tokens, spreadsheetId, range, values) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Sheets write failed.');
  return { updatedCells: d.updatedCells, updatedRange: d.updatedRange };
}

export async function sheetsAppend(tokens, spreadsheetId, range, values) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values })
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Sheets append failed.');
  return { updatedCells: d.updates?.updatedCells };
}

// ===== Google Docs =====
const DOCS_API = 'https://docs.googleapis.com/v1/documents';

export async function docsCreate(tokens, title) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(DOCS_API, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Docs create failed.');
  return { documentId: d.documentId, title: d.title };
}

export async function docsRead(tokens, documentId) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${DOCS_API}/${encodeURIComponent(documentId)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Docs read failed.');
  // Extract text
  let text = '';
  function extractContent(content) {
    for (const el of content || []) {
      if (el.paragraph?.elements) {
        for (const e of el.paragraph.elements) {
          if (e.textRun?.content) text += e.textRun.content;
        }
      }
      if (el.table?.tableRows) {
        for (const row of el.table.tableRows) {
          for (const cell of row.tableCells || []) {
            extractContent(cell.content);
          }
        }
      }
    }
  }
  extractContent(d.body?.content);
  return { documentId: d.documentId, title: d.title, text: text.slice(0, 8000) };
}

export async function docsAppendText(tokens, documentId, text) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${DOCS_API}/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text } }] })
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Docs append failed.');
  return { updated: true };
}

// ===== Google Slides =====
const SLIDES_API = 'https://slides.googleapis.com/v1/presentations';

export async function slidesCreate(tokens, title) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(SLIDES_API, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Slides create failed.');
  return { presentationId: d.presentationId, title: d.title };
}

export async function slidesRead(tokens, presentationId) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${SLIDES_API}/${encodeURIComponent(presentationId)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Slides read failed.');
  const slides = (d.slides || []).map((s, i) => {
    let text = '';
    for (const el of s.pageElements || []) {
      if (el.shape?.text?.textElements) {
        for (const te of el.shape.text.textElements) {
          if (te.textRun?.content) text += te.textRun.content;
        }
      }
    }
    return `Slide ${i + 1}: ${text.trim()}`;
  });
  return { presentationId: d.presentationId, title: d.title, slides };
}

// ===== Google Calendar =====
const CAL_API = 'https://www.googleapis.com/calendar/v3';

export async function calendarListEvents(tokens, calendarId = 'primary', maxResults = 10, timeMin) {
  const accessToken = await getValidAccessToken(tokens);
  const params = new URLSearchParams({ maxResults: String(Math.min(maxResults, 50)), singleEvents: 'true', orderBy: 'startTime' });
  if (timeMin) params.set('timeMin', timeMin);
  else params.set('timeMin', new Date().toISOString());
  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Calendar list failed.');
  return (d.items || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location,
    description: e.description
  }));
}

export async function calendarCreateEvent(tokens, calendarId = 'primary', event) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Calendar create failed.');
  return { id: d.id, htmlLink: d.htmlLink, summary: d.summary };
}

export async function calendarDeleteEvent(tokens, calendarId = 'primary', eventId) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok && res.status !== 204) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d?.error?.message || 'Calendar delete failed.');
  }
  return { deleted: true };
}

export async function calendarListCalendars(tokens) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${CAL_API}/users/me/calendarList`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Calendar list calendars failed.');
  return (d.items || []).map((c) => ({ id: c.id, summary: c.summary, primary: c.primary }));
}

// ===== Google Contacts (People API) =====
const PEOPLE_API = 'https://people.googleapis.com/v1';

export async function contactsList(tokens, pageSize = 20) {
  const accessToken = await getValidAccessToken(tokens);
  const params = new URLSearchParams({ pageSize: String(Math.min(pageSize, 50)), 'personFields': 'names,emailAddresses,phoneNumbers' });
  const res = await fetch(`${PEOPLE_API}/people/me/connections?${params.toString()}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Contacts list failed.');
  return (d.connections || []).map((c) => ({
    resourceName: c.resourceName,
    name: c.names?.[0]?.displayName || '',
    email: c.emailAddresses?.[0]?.value || '',
    phone: c.phoneNumbers?.[0]?.value || ''
  }));
}

export async function contactsCreate(tokens, name, email, phone) {
  const accessToken = await getValidAccessToken(tokens);
  const body = { names: [{ givenName: name }] };
  if (email) body.emailAddresses = [{ value: email }];
  if (phone) body.phoneNumbers = [{ value: phone }];
  const res = await fetch(`${PEOPLE_API}/people:createContact`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || 'Contact create failed.');
  return { resourceName: d.resourceName, name: d.names?.[0]?.displayName || name };
}

export async function contactsDelete(tokens, resourceName) {
  const accessToken = await getValidAccessToken(tokens);
  const res = await fetch(`${PEOPLE_API}/${resourceName}:deleteContact`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok && res.status !== 204) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d?.error?.message || 'Contact delete failed.');
  }
  return { deleted: true };
}
