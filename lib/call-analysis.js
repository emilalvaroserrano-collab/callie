import 'server-only';

const MAX_TRANSCRIPT_CHARS = 6000;

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function formatDuration(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function buildTranscriptText(transcript) {
  const lines = [];
  let used = 0;
  for (const entry of transcript || []) {
    const role = entry?.role === 'user' ? 'Caller' : 'Agent';
    const text = clean(entry?.text, 500);
    if (!text) continue;
    const line = `${role}: ${text}`;
    if (used + line.length + 1 > MAX_TRANSCRIPT_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

async function geminiAnalysis(transcriptText, persona, durationSeconds) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '';
  if (!apiKey) return null;

  const name = clean(persona?.name, 60) || 'the agent';
  const company = clean(persona?.company, 100) || 'the company';
  const prompt = [
    `You are a call analyst for ${company}.`,
    `Read the transcript of a customer-service call handled by ${name} and write a concise "Call Summary"`,
    `(2-4 sentences) describing the caller's intent, what was discussed, and the outcome/resolution.`,
    `Then list 2-4 short "Key points" as bullet lines starting with "- ".`,
    `Keep the whole response under 900 characters. Do not include the transcript itself.`,
    '',
    `Call duration: ${formatDuration(durationSeconds)}`,
    '',
    'Transcript:',
    transcriptText
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 300 }
        }),
        signal: controller.signal
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function heuristicAnalysis(transcript, durationSeconds) {
  const callerLines = (transcript || []).filter((e) => e?.role === 'user').map((e) => clean(e.text, 200)).filter(Boolean);
  const agentLines = (transcript || []).filter((e) => e?.role !== 'user').map((e) => clean(e.text, 200)).filter(Boolean);

  if (!callerLines.length && !agentLines.length) {
    return 'No conversation was captured for this call.';
  }

  const parts = [];
  parts.push(`Call lasted ${formatDuration(durationSeconds)}.`);
  if (callerLines.length) {
    parts.push(`The caller opened with: "${callerLines[0]}".`);
  }
  if (callerLines.length > 1) {
    parts.push(`The caller raised ${callerLines.length} message(s) in total.`);
  }
  if (agentLines.length) {
    parts.push(`The agent responded ${agentLines.length} time(s); final response: "${agentLines[agentLines.length - 1]}".`);
  }
  return parts.join(' ');
}

export async function generateCallAnalysis(input) {
  const transcript = Array.isArray(input?.transcript) ? input.transcript : [];
  const transcriptText = buildTranscriptText(transcript);

  if (!transcriptText) {
    return 'No conversation was captured for this call.';
  }

  const ai = await geminiAnalysis(transcriptText, input?.persona, input?.durationSeconds);
  if (ai) return ai;

  return heuristicAnalysis(transcript, input?.durationSeconds);
}
