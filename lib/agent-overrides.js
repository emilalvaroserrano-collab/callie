import 'server-only';

import promptData from './agent-system-prompt.json';

const DEFAULT_PROMPT = promptData.systemPrompt;
const VOICES = new Set(['Elliot', 'Emma', 'Clara', 'Kai', 'Godfrey', 'Sid', 'Savannah', 'Layla']);

function normalizeUrl(raw) {
  const value = (raw || '').trim();
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/* Returns a canonical absolute URL, or '' when the value is not a valid web URL. */
function canonicalUrl(raw) {
  const value = normalizeUrl(raw);
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return '';
    return parsed.href;
  } catch (error) {
    return '';
  }
}

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function hydrateFirstMessage(persona) {
  const name = persona.name || 'Alex';
  const company = persona.company || 'your company';
  const message = persona.firstMessage || 'Hey there, thanks for calling {{company}}, this is {{persona}}. Who am I speaking with today, and what can I help you with?';
  return message.replaceAll('{{persona}}', name).replaceAll('{{company}}', company);
}

function hydratePrompt(persona) {
  const language = persona.language || 'English';
  return DEFAULT_PROMPT
    .replaceAll('{{PERSONA_UPPER}}', persona.name.toUpperCase())
    .replaceAll('{{persona}}', persona.name)
    .replaceAll('{{COMPANY_UPPER}}', persona.company.toUpperCase())
    .replaceAll('{{company}}', persona.company)
    .replaceAll('{{website}}', persona.website || 'Not provided')
    .replaceAll('{{language}}', language);
}

/**
 * Builds the transient assistant config sent to Vapi. This runs on the server
 * so the master system prompt never ships in the page bundle.
 */
function getAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

export function buildOverrides(input) {
  const name = clean(input?.name, 60);
  const company = clean(input?.company, 100);
  if (!name || !company) {
    throw new Error('Name and company are required.');
  }

  const voice = VOICES.has(input?.voice) ? input.voice : 'Elliot';
  const language = clean(input?.language, 100) || 'English';
  const rawWebsite = clean(input?.website, 250);
  const website = canonicalUrl(rawWebsite);
  const firstMessage = clean(input?.firstMessage, 4000);

  const uid = clean(input?.uid, 128);
  const gmailConnected = Boolean(input?.gmailConnected);
  const gmailEmail = clean(input?.gmailEmail, 200);

  if (rawWebsite && !website) {
    throw new Error('Enter a valid website URL.');
  }

  const persona = {
    name,
    company,
    website,
    voice,
    language,
    firstMessage
  };

  const knowledgeUrl = canonicalUrl(clean(input?.websiteKnowledgeUrl, 250));
  const knowledge = knowledgeUrl && knowledgeUrl === website
    ? clean(input?.websiteKnowledge, 5500)
    : '';

  let systemContent = hydratePrompt(persona);
  systemContent += `\n\n---\n\n### [MAIN LANGUAGE & MULTILINGUAL FLUENCY]\n\nConfigured Main Language: ${language}\n\nSpeak ${language} as your primary language with complete native fluency—using natural everyday idioms, local phrasing, warmth, empathy, and conversational fillers rather than stiff or translated-sounding speech. Stay fully multilingual: if the caller speaks or requests another language, transition smoothly and naturally into their preferred language while keeping your human CSR personality.`;

  if (website) {
    systemContent += `\n\n---\n\n### [COMPANY WEBSITE KNOWLEDGE BASE]\n\nOfficial Website for ${company}: ${website}\n`;
    if (knowledge) {
      systemContent += `\nUse the following retrieved content from ${website} as your verified company knowledge base when callers ask about ${company}, its services, products, background, or contact details. Speak from it naturally in conversation without sounding like you are reading a webpage, and never invent offerings or prices not found here or in verified company tools:\n\n"""\n${knowledge}\n"""`;
    } else {
      systemContent += `\nLive page content from ${website} could not be loaded for this session. Mention ${website} as ${company}'s official website when helpful, rely only on verified details in your instructions or tools, and never guess unverified products, pricing, or policies.`;
    }
  }

  const overrides = {
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: systemContent }]
    },
    voice: {
      provider: 'vapi',
      voiceId: voice,
      version: 2,
      language: 'auto'
    },
    firstMessage: hydrateFirstMessage(persona),
    firstMessageMode: 'assistant-speaks-first',
    endCallMessage: `Thanks for calling ${company}. Have a great day!`,
    voicemailMessage: `Hello, this is ${name} from ${company}. Please call us again when you can.`
  };

  if (gmailConnected && uid) {
    const serverUrl = `${getAppUrl()}/api/gmail/tool?uid=${encodeURIComponent(uid)}`;
    overrides.tools = [
      {
        type: 'function',
        function: {
          name: 'gmail_list_messages',
          description: `List recent emails in the user's Gmail inbox. Use this when the caller asks to check, read, or review their emails. Optionally filter with a Gmail search query.`,
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Gmail search query (optional). E.g. "is:unread", "from:example.com", "subject:invoice".' },
              maxResults: { type: 'number', description: 'Max number of messages to return (default 10, max 20).' }
            }
          }
        },
        server: { url: serverUrl }
      },
      {
        type: 'function',
        function: {
          name: 'gmail_read_message',
          description: 'Read the full content of a specific email by its message ID.',
          parameters: {
            type: 'object',
            properties: {
              messageId: { type: 'string', description: 'The Gmail message ID.' }
            },
            required: ['messageId']
          }
        },
        server: { url: serverUrl }
      },
      {
        type: 'function',
        function: {
          name: 'gmail_search_messages',
          description: 'Search emails in Gmail using a search query.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Gmail search query. E.g. "is:unread", "from:boss@company.com", "newer_than:1d".' },
              maxResults: { type: 'number', description: 'Max number of messages (default 10, max 20).' }
            },
            required: ['query']
          }
        },
        server: { url: serverUrl }
      },
      {
        type: 'function',
        function: {
          name: 'gmail_send_email',
          description: 'Send an email on behalf of the user.',
          parameters: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Recipient email address.' },
              subject: { type: 'string', description: 'Email subject.' },
              body: { type: 'string', description: 'Email body (plain text).' }
            },
            required: ['to', 'subject', 'body']
          }
        },
        server: { url: serverUrl }
      },
      {
        type: 'function',
        function: {
          name: 'gmail_delete_message',
          description: 'Delete or trash an email message.',
          parameters: {
            type: 'object',
            properties: {
              messageId: { type: 'string', description: 'The Gmail message ID.' },
              permanent: { type: 'boolean', description: 'If true, permanently delete; otherwise move to trash.' }
            },
            required: ['messageId']
          }
        },
        server: { url: serverUrl }
      },
      {
        type: 'function',
        function: {
          name: 'gmail_list_labels',
          description: 'List all Gmail labels (folders) for the user.',
          parameters: { type: 'object', properties: {} }
        },
        server: { url: serverUrl }
      },
      {
        type: 'function',
        function: {
          name: 'gmail_get_profile',
          description: 'Get the Gmail profile info (email address, total messages).',
          parameters: { type: 'object', properties: {} }
        },
        server: { url: serverUrl }
      }
    ];

    // Additional Google Workspace tools
    const extraTools = [
      { name: 'drive_list_files', desc: 'List files in Google Drive.', params: { query: 'string', maxResults: 'number' } },
      { name: 'drive_search_files', desc: 'Search files in Google Drive by name.', params: { query: 'string', maxResults: 'number' } },
      { name: 'sheets_create', desc: 'Create a new Google Spreadsheet.', params: { title: 'string' }, required: ['title'] },
      { name: 'sheets_read', desc: 'Read values from a spreadsheet range.', params: { spreadsheetId: 'string', range: 'string' }, required: ['spreadsheetId', 'range'] },
      { name: 'docs_create', desc: 'Create a new Google Doc.', params: { title: 'string' }, required: ['title'] },
      { name: 'docs_read', desc: 'Read the content of a Google Doc.', params: { documentId: 'string' }, required: ['documentId'] },
      { name: 'slides_create', desc: 'Create a new Google Slides presentation.', params: { title: 'string' }, required: ['title'] },
      { name: 'calendar_list_events', desc: 'List upcoming calendar events.', params: { calendarId: 'string', maxResults: 'number' } },
      { name: 'calendar_create_event', desc: 'Create a calendar event.', params: { summary: 'string', start: 'string', end: 'string', timeZone: 'string' }, required: ['summary', 'start', 'end'] },
      { name: 'calendar_delete_event', desc: 'Delete a calendar event.', params: { eventId: 'string' }, required: ['eventId'] },
      { name: 'contacts_list', desc: 'List Google contacts.', params: { pageSize: 'number' } },
    ];
    for (const t of extraTools) {
      const properties = {};
      for (const [k, v] of Object.entries(t.params || {})) {
        if (v === 'array') {
          properties[k] = { type: 'array', items: { type: 'array', items: { type: 'string' } } };
        } else {
          properties[k] = { type: v };
        }
      }
      overrides.tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.desc,
          parameters: {
            type: 'object',
            properties,
            required: t.required || []
          }
        },
        server: { url: serverUrl }
      });
    }

    // Add Google Workspace context to system prompt.
    systemContent += `\\n\\n---\\n\\n### [GOOGLE WORKSPACE INTEGRATION]\\n\\nThe user has connected their Google Workspace account (${gmailEmail || 'connected'}). You have tools to manage Gmail, Google Drive, Sheets, Docs, Slides, Calendar, and Contacts. Use them when the caller asks. Always confirm before sending, deleting, or modifying data.`;
    // Add Google Workspace context to system prompt.
    systemContent += `\\n\\n---\\n\\n### [GOOGLE WORKSPACE INTEGRATION]\\n\\nThe user has connected their Google Workspace account (${gmailEmail || 'connected'}). You have tools to manage Gmail, Google Drive, Sheets, Docs, Slides, Calendar, and Contacts. Use them when the caller asks. Always confirm before sending, deleting, or modifying data.`;
    overrides.model.messages[0].content = systemContent;
  }

  return overrides;
}
