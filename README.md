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

## WhatsApp call reports

After a call finishes, CSR Studio can send a transcript summary to the agent owner's
WhatsApp. This requires a small Baileys bridge that runs as a separate long-lived
service (Vercel cannot host the persistent WhatsApp socket). The bridge is provided
in `whatsapp-service/` and ships with a Dockerfile.

### Environment variables

Add these to Vercel (and to the bridge's `.env`):

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_SERVICE_URL` | Public HTTPS URL of the Baileys bridge (no trailing slash) |
| `WHATSAPP_SERVICE_SECRET` | Shared secret between Next.js and the bridge (>= 16 chars) |

### Run the bridge with Docker

```bash
cp whatsapp-service/.env.example whatsapp-service/.env
# set WHATSAPP_SERVICE_SECRET to the same value used in Vercel
openssl rand -hex 32  # paste into both .env files

docker compose up -d --build
```

The compose file binds the service to `127.0.0.1:8080`. For Vercel to reach it,
expose it through a reverse proxy (Caddy, Nginx, or a tunnel) and set
`WHATSAPP_SERVICE_URL` to that public HTTPS URL. Example Caddyfile:

```caddy
whatsapp.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Auth state is persisted in the `whatsapp_data` Docker volume, so linked sessions
survive container restarts.

### How it works

- `app/api/whatsapp/session` — verifies the Firebase ID token, then proxies to
  the bridge (QR or pairing-code link, status, disconnect, logout).
- `app/api/whatsapp/send` — sends an arbitrary message through the linked account.
- `app/api/whatsapp/report` — builds a call summary server-side from call metadata
  and the transcript, then sends it. The master system prompt is never involved.
- `components/StudioApp.js` — WhatsApp card in the studio with status, modal, auto-send
  toggle, optional destination number, and a test action. On `call-end`, a summary is
  sent when auto-send is enabled and the call connected.
EOF
