import 'server-only';

const MAX_TRANSCRIPT_CHARS = 3600;
const MAX_TOTAL_CHARS = 9500;

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function formatWhen(iso, timeZone) {
  let date;
  try {
    date = iso ? new Date(iso) : new Date();
    if (Number.isNaN(date.getTime())) date = new Date();
  } catch {
    date = new Date();
  }
  const options = { dateStyle: 'medium', timeStyle: 'short' };
  if (typeof timeZone === 'string' && timeZone.trim()) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() });
      options.timeZone = timeZone.trim();
    } catch {
      // ignore invalid tz
    }
  }
  try {
    return new Intl.DateTimeFormat('en-US', options).format(date);
  } catch {
    return date.toISOString();
  }
}

export function buildCallSummary(input) {
  const persona = input?.persona || {};
  const name = clean(persona.name, 60) || 'Assistant';
  const company = clean(persona.company, 100) || 'your company';
  const when = formatWhen(input?.startedAt, input?.timeZone);
  const duration = formatDuration(input?.durationSeconds);
  const callId = clean(input?.callId, 120);

  const lines = [];
  lines.push(`*Call summary — ${company}*`);
  lines.push(`Agent: ${name}`);
  lines.push(`Time: ${when}`);
  lines.push(`Duration: ${duration}`);
  if (callId) lines.push(`Call ID: ${callId}`);
  lines.push('');
  lines.push('*Conversation*');

  const transcript = Array.isArray(input?.transcript) ? input.transcript : [];
  const rendered = [];
  let used = 0;
  let truncated = false;
  for (const entry of transcript) {
    const role = entry?.role === 'user' ? 'Caller' : name;
    const text = clean(entry?.text, 1000);
    if (!text) continue;
    const line = `${role}: ${text}`;
    if (used + line.length + 1 > MAX_TRANSCRIPT_CHARS) {
      truncated = true;
      break;
    }
    rendered.push(line);
    used += line.length + 1;
  }

  if (rendered.length) {
    lines.push(...rendered);
    if (truncated) lines.push('… (transcript truncated)');
  } else {
    lines.push('No transcript was captured for this call.');
  }

  let summary = lines.join('\n');
  if (summary.length > MAX_TOTAL_CHARS) {
    summary = summary.slice(0, MAX_TOTAL_CHARS - 20) + '\n… (truncated)';
  }
  return summary;
}
