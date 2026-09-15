/**
 * Relayer-contract baseline for this MCP package.
 *
 * The stdio server no longer probes `/version` itself — the SDK does that
 * on the first signed request. This constant still has to match
 * `MIN_MCP_PACKAGE_VERSION` in the relayer (`scripts/check-compatibility-contract.mjs`).
 */
export const MEMWAL_MCP_COMPATIBILITY_VERSION = "0.0.1";
export const SUPPORTED_RELAYER_API_MAJOR = 1;
