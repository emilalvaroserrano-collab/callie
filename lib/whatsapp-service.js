import 'server-only';

const DEFAULT_TIMEOUT_MS = 15000;

export class WhatsAppConfigError extends Error {
  constructor() {
    super('WhatsApp reporting is not configured on the server.');
    this.status = 503;
  }
}

export function getWhatsAppConfig() {
  const url = (process.env.WHATSAPP_SERVICE_URL || '').trim().replace(/\/+$/, '');
  const secret = process.env.WHATSAPP_SERVICE_SECRET || '';
  return { url, secret, configured: Boolean(url && secret) };
}

export async function whatsappRequest(path, options = {}) {
  const config = getWhatsAppConfig();
  if (!config.configured) throw new WhatsAppConfigError();

  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        'x-service-secret': config.secret,
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      cache: 'no-store'
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 200) };
      }
    }

    if (!response.ok) {
      const error = new Error(data?.error || `WhatsApp service error (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('The WhatsApp service did not respond in time.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    if (error?.status) throw error;
    const networkError = new Error(
      'The WhatsApp service is unreachable. Check WHATSAPP_SERVICE_URL and the service health.'
    );
    networkError.status = 502;
    throw networkError;
  } finally {
    clearTimeout(timer);
  }
}
