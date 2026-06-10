/**
 * SEAL + Walrus HTTP Sidecar Server — entry point.
 *
 * Long-lived Express server that wraps SEAL encrypt/decrypt and Walrus upload.
 * Started once at server boot (services/server/src/main.rs spawns
 * `tsx sidecar-server.ts`) — eliminates ~1-2s Node.js cold-start per call.
 *
 * The implementation lives in ./sidecar/:
 *   config.ts        — env-driven configuration
 *   clients.ts       — shared Sui / SEAL / Walrus clients + refresh lifecycle
 *   concurrency.ts   — global/per-wallet upload limiting
 *   enoki.ts         — Enoki sponsorship API client
 *   wallet.ts        — server-wallet tx submission (metrics, retries)
 *   blob-metadata.ts — metadata-stamp + transfer-to-owner transaction
 *   middleware.ts    — request-id, CORS-strip, shared-secret auth
 *   routes/          — one module per endpoint group
 *   app.ts           — Express app assembly (route/middleware order)
 *   server.ts        — bootstrap + graceful shutdown
 *
 * Endpoints:
 *   GET  /health                     → liveness + upload-limiter state (no auth)
 *   GET  /metrics/wallet             → wallet-execution counters (no auth)
 *   /mcp/*                           → MCP session routes (own auth; see mcp/)
 *   POST /seal/encrypt               → { data, owner, packageId } → { encryptedData }
 *   POST /seal/decrypt               → { data, packageId, accountId } → { decryptedData }
 *   POST /seal/decrypt-batch         → { items[], packageId, accountId } → { results[], errors[] }
 *   POST /walrus/upload              → { data, keyIndex, owner?, ... } → { blobId, objectId }
 *   POST /walrus/set-metadata-batch  → { blobs[], owner, keyIndex } → { transferred, digest }
 *   POST /walrus/set-metadata        → legacy single-blob variant
 *   POST /walrus/query-blobs         → { owner, namespace?, ... } → { blobs[], total }
 *   POST /sponsor                    → { transactionBlockKindBytes, sender } → { bytes, digest }
 *   POST /sponsor/execute            → { digest, signature } → { digest }
 */

import { startSidecarServer } from "./sidecar/server.js";

startSidecarServer();
