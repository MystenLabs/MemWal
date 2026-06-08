# Walrus Memory Status

Standalone status service for Walrus Memory.

The browser app calls this service at `/api/status`. The Node server then probes
`STATUS_RELAYER_URL/health` server-side, so the relayer does not need to allow
the status page origin through CORS.

## Local development

```sh
pnpm --filter @memwal/status dev
```

This builds the client and runs the same Node server used in production. For
client-only Vite work without the probe API, use:

```sh
pnpm --filter @memwal/status dev:client
```

## Runtime env

- `STATUS_RELAYER_URL`: relayer base URL, default `https://relayer.memory.walrus.xyz`
- `STATUS_HEALTH_PATH`: health path, default `/health`
- `STATUS_REQUEST_TIMEOUT_MS`: probe timeout, default `8000`
