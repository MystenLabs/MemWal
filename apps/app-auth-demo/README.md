# Walrus Memory App Auth Demo

Tiny backend-served demo app for testing `Connect Walrus Memory` from a third-party app.

## Local

```bash
pnpm dev:app-auth-demo
```

Default local config:

```txt
PORT=3000
MEMWAL_WEB_URL=http://localhost:5173
MEMWAL_API_URL=http://localhost:8000
APP_LABEL=Demo App
```

On first connect, the demo registers itself with `POST /api/app-auth/clients`
using its exact HTTPS callback/fallback URLs. Public self-registration rejects
localhost and `*.memwal.ai` URLs; for local demos, use the optional static
`dev_localhost` client instead.

## Deployed Demo App

Deploy this demo app with:

```txt
PORT=3000
APP_BASE_URL=https://my-demo-app.example.com
MEMWAL_WEB_URL=https://dev.memwal.ai
MEMWAL_API_URL=https://relayer.dev.memwal.ai
APP_LABEL=Demo App
```

`APP_BASE_URL` is required on Railway and other deployed hosts. It makes the demo generate public HTTPS callback/fallback URLs behind the platform proxy and marks the state cookie `Secure`.

The relayer must also be configured for the intended scale:

- Staging/dev demo: set `APP_AUTH_PUBLIC_CLIENT_REGISTRATION_ENABLED=true` on the relayer so this app can auto-register.
- Production: leave public registration disabled. An operator creates the client with `Authorization: Bearer $APP_AUTH_ADMIN_TOKEN` and gives the `client_id` / one-time `client_secret` to the dapp developer.

Railway service config is included at `apps/app-auth-demo/railway.json` and uses `apps/app-auth-demo/Dockerfile`. Set Railway Root Directory to the repo root (`/`) so the Dockerfile path resolves correctly.

Google Console does not need every dApp callback URL. Google/Enoki auth is handled by Walrus Memory, so Google Console only needs Walrus Memory origins/callbacks such as `https://dev.memwal.ai` and `https://memwal.ai`.

## How Other Dapps Access It

Third-party apps do not integrate Enoki directly. They register their backend
app once, redirect the browser to Walrus Memory hosted connect, and exchange the
returned code server-side.

Register the app from your backend:

```bash
curl -X POST "$MEMWAL_API_URL/api/app-auth/clients" \
  -H 'content-type: application/json' \
  --data '{
    "display_name": "My Dapp",
    "redirect_uris": ["https://my-dapp.example.com/api/memwal/callback"],
    "fallback_uris": ["https://my-dapp.example.com/memwal/error"]
  }'
```

For staging/dev, that request works when public registration is enabled on the
relayer. For production, the same request must be made by a Walrus Memory
operator with `Authorization: Bearer $APP_AUTH_ADMIN_TOKEN`; end users never
create app clients. Store the returned `client_id` and `client_secret` in your
backend env. The client is active immediately unless an operator later blocks
it. Then send users to:

```txt
https://dev.memwal.ai/connect/app?client_id=CLIENT_ID&redirect_uri=https%3A%2F%2Fmy-dapp.example.com%2Fapi%2Fmemwal%2Fcallback&state=RANDOM_STATE&label=My%20Dapp&intent=sdk_delegate&fallback_uri=https%3A%2F%2Fmy-dapp.example.com%2Fmemwal%2Ferror
```

Walrus Memory handles Google/Enoki or wallet auth on `dev.memwal.ai`. Your dapp
only receives `code + state`, then exchanges the code with HTTP Basic auth:

```bash
curl -X POST "$MEMWAL_API_URL/api/app-auth/token" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H 'content-type: application/json' \
  --data '{
    "grant_type": "authorization_code",
    "code": "CODE_FROM_CALLBACK",
    "redirect_uri": "https://my-dapp.example.com/api/memwal/callback",
    "state": "ORIGINAL_RANDOM_STATE"
  }'
```

## Copy-Paste Vercel/Railway Shape

Use these environment variables in the deployed app:

```txt
APP_BASE_URL=https://your-app.railway.app
MEMWAL_WEB_URL=https://dev.memwal.ai
MEMWAL_API_URL=https://relayer.dev.memwal.ai
APP_LABEL=Your App
```
