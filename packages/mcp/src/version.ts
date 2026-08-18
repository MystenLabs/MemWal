/**
 * Package version, read from package.json at runtime.
 *
 * Reported as `serverInfo.version` in the MCP `initialize` handshake so client
 * logs identify which build a user is actually running. It was previously
 * hardcoded to "0.0.1" in two separate handshakes while the package shipped
 * 0.0.5, so every user's log claimed the same fake version and field triage of
 * MCP issues was guesswork (WALM-324).
 *
 * NOT the same value as `MEMWAL_MCP_COMPATIBILITY_VERSION` in compatibility.ts.
 * That one is a deliberately pinned relayer-contract baseline, checked against
 * the Rust `MIN_MCP_PACKAGE_VERSION` by scripts/check-compatibility-contract.mjs,
 * and must NOT track the release version.
 *
 * `../package.json` resolves correctly from any emitted module because tsc maps
 * rootDir `src/` onto outDir `dist/`, and npm always includes package.json in
 * the published tarball.
 */
import { createRequire } from "node:module";

const requirePkg = createRequire(import.meta.url);

export const MEMWAL_MCP_VERSION: string =
    (requirePkg("../package.json") as { version?: string }).version ?? "0.0.0";
