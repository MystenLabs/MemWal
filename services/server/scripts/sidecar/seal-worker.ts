/**
 * Child process entry. The parent forks this file; do not start it from the
 * main sidecar or it will listen twice.
 */

import { createSealApp } from "./seal-app.js";
import { SIDECAR_SEAL_HOST, SIDECAR_SEAL_PORT } from "./config.js";

// The relayer SIGKILLs the upload process on a failed boot. That skips the
// parent's SIGTERM handler, so this child must exit when its IPC channel
// closes or it keeps the seal port and the next boot cannot bind.
process.on("disconnect", () => {
    process.exit(0);
});

const server = createSealApp().listen(SIDECAR_SEAL_PORT, SIDECAR_SEAL_HOST, () => {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : SIDECAR_SEAL_PORT;
    console.log(JSON.stringify({ event: "seal_listener_ready", host: SIDECAR_SEAL_HOST, port }));
    process.send?.({ type: "ready", port });
});

server.on("error", (err) => {
    console.error(`[seal-listener] bind failed: ${err.message}`);
    process.exit(1);
});
