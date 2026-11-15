import 'server-only';

const FIREBASE_LOOKUP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';

export async function verifyFirebaseToken(request) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) {
    return { ok: false, status: 503, error: 'Firebase is not configured on the server.' };
  }

  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return { ok: false, status: 401, error: 'Your session could not be verified. Please sign in again.' };
  }

  try {
    const response = await fetch(`${FIREBASE_LOOKUP_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      cache: 'no-store'
    });
    if (!response.ok) {
      return { ok: false, status: 401, error: 'Your session could not be verified. Please sign in again.' };
    }
    const data = await response.json();
    const user = Array.isArray(data?.users) ? data.users[0] : null;
    if (!user?.localId) {
      return { ok: false, status: 401, error: 'Your session could not be verified. Please sign in again.' };
    }
    return { ok: true, uid: user.localId, email: user.email || '' };
  } catch (error) {
    return { ok: false, status: 503, error: 'Unable to verify your session right now. Please try again.' };
  }
}
