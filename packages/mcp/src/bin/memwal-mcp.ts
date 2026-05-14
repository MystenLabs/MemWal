#!/usr/bin/env node
import { main } from "../index.js";

main().catch((err) => {
    process.stderr.write(`[memwal-mcp] fatal: ${err?.message ?? String(err)}\n`);
    if (err?.stack && process.env.MEMWAL_MCP_DEBUG) {
        process.stderr.write(err.stack + "\n");
    }
    process.exit(1);
});
