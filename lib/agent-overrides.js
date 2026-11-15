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

  return {
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
}
