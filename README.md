# CSR Studio

Next.js app for building a customer-service voice persona and testing it with a
Vapi browser call. Signed-out visitors are sent to `/auth`; signed-in users get
the studio at `/`.

## Local development

```bash
cp .env.example .env   # fill in Firebase and Vapi values
npm install
npm run dev            # http://localhost:3000
```

## Environment variables

All configuration is read on the server from environment variables. Nothing is
hardcoded in the repo, and no `NEXT_PUBLIC_*` values are used.

| Variable | Purpose |
| --- | --- |
| `FIREBASE_API_KEY` | Firebase web API key |
| `FIREBASE_AUTH_DOMAIN` | Firebase Auth domain |
| `FIREBASE_DATABASE_URL` | Realtime Database URL |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_STORAGE_BUCKET` | Storage bucket |
| `FIREBASE_MESSAGING_SENDER_ID` | Messaging sender ID |
| `FIREBASE_APP_ID` | Web app ID |
| `FIREBASE_MEASUREMENT_ID` | Analytics measurement ID |
| `VAPI_PUBLIC_KEY` | Vapi public web key |
| `VAPI_ASSISTANT_ID` | Vapi assistant ID |

Set these in Vercel under **Settings → Environment Variables** for Production,
Preview, and Development.

## How it works

- `app/page.js` — server page; reads config and renders the studio.
- `app/auth/page.js` — server page; reads config and renders sign-in.
- `components/StudioApp.js` — studio UI, persona storage, call flow.
- `components/AuthApp.js` — sign-in/sign-up, password reset, redirects.
- `app/api/vapi-overrides/route.js` — verifies the Firebase ID token, then
  builds the transient assistant overrides (system prompt, knowledge, voice).
- `lib/agent-overrides.js` — server-only prompt hydration and validation.
- `lib/agent-system-prompt.json` — master system prompt; server bundle only.

The master system prompt is never included in client JavaScript. The browser
only sends the persona fields and receives the assembled overrides from the API.

## Deploy

The app deploys to Vercel as a standard Next.js project:

```bash
vercel --prod
```

Production: <https://csragent.vercel.app>
