import 'server-only';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
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
