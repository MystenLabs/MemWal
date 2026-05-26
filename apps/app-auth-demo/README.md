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
MEMWAL_CLIENT_ID=dev_localhost
MEMWAL_CLIENT_SECRET=dev_localhost_secret
```

Walrus Memory server must run with `APP_AUTH_ENABLE_DEV_LOCALHOST_WILDCARDS=true` on a non-mainnet network for the built-in `dev_localhost` client.

## Deployed Demo App

For deployed testing, register the exact deployed callback and fallback URLs in Walrus Memory's env-backed client list.

Generate a client secret hash:

```bash
SECRET="my_demo_secret"
HASH=$(printf '%s' "$SECRET" | shasum -a 256 | awk '{print $1}')
echo "$HASH"
```

Add the app to Walrus Memory server env:

```txt
APP_AUTH_CLIENTS_JSON=[{"client_id":"my_demo","client_secret_sha256":"PASTE_HASH_HERE","display_name":"My Demo App","allowed_redirect_uris":["https://my-demo-app.example.com/api/memwal/callback"],"fallback_uri":"https://my-demo-app.example.com/memwal/error","allowed_fallback_uris":["https://my-demo-app.example.com/memwal/error"]}]
```

Deploy this demo app with:

```txt
PORT=3000
APP_BASE_URL=https://my-demo-app.example.com
MEMWAL_WEB_URL=https://dev.memwal.ai
MEMWAL_API_URL=https://api-dev.memwal.ai
MEMWAL_CLIENT_ID=my_demo
MEMWAL_CLIENT_SECRET=my_demo_secret
APP_LABEL=My Demo App
```

`APP_BASE_URL` makes the demo generate deployed callback/fallback URLs even when it is behind a platform proxy.

Google Console does not need every dApp callback URL. Google/Enoki auth is handled by Walrus Memory, so Google Console only needs Walrus Memory origins/callbacks such as `https://dev.memwal.ai` and `https://memwal.ai`.

## Copy-Paste Vercel/Railway Shape

Use these environment variables in the deployed app:

```txt
APP_BASE_URL=https://your-app.vercel.app
MEMWAL_WEB_URL=https://dev.memwal.ai
MEMWAL_API_URL=https://api-dev.memwal.ai
MEMWAL_CLIENT_ID=your_client_id
MEMWAL_CLIENT_SECRET=your_client_secret
APP_LABEL=Your App
```

Then add the exact URLs to `APP_AUTH_CLIENTS_JSON` on Walrus Memory:

```txt
https://your-app.vercel.app/api/memwal/callback
https://your-app.vercel.app/memwal/error
```
