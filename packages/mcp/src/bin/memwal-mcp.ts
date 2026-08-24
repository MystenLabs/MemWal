#!/usr/bin/env node
import { main } from "../index.js";

main().catch((err) => {
    process.stderr.write(`[memwal-mcp] fatal: ${err?.message ?? String(err)}\n`);
    if (err?.stack && process.env.MEMWAL_MCP_DEBUG) {
        process.stderr.write(err.stack + "\n");
    }
    // Let the event loop drain so undici/libuv can close the handshake
    // socket. process.exit(1) here asserts on Windows (UV_HANDLE_CLOSING).
    process.exitCode = 1;
});
