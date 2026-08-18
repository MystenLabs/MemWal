/**
 * MCP `instructions` payloads for the two local initialize responders.
 *
 * Clients inject this field into the model's system prompt during the
 * `initialize` handshake, before any `tools/list`. That makes it the only
 * proactive-usage channel that survives lazy tool loading, which is what broke
 * proactive save/recall in the first place (WALM-324): the guidance used to
 * live only in tool descriptions, and clients stopped putting those in context
 * until a tool was explicitly loaded.
 *
 * Both local responders need their own copy because the bridge answers
 * `initialize` itself and SUPPRESSES the relayer's reply (see
 * `buildLocalInitializeResult` in bridge.ts). Without this, the relayer's
 * instructions are correct but unreachable for every stdio client.
 *
 * The relayer keeps a separate copy in
 * services/server/scripts/mcp/server.ts, which serves the direct HTTP/OAuth
 * connector path. It cannot share this module: that file belongs to the
 * standalone `memwal-server-scripts` npm package with no workspace link here.
 * Keep the two in sync.
 */

/** Signed-in path (bridge mode). Full proactive contract. */
export const PROACTIVE_INSTRUCTIONS = [
    "Walrus Memory is this user's persistent memory system, exposed through the memwal_* tools.",
    "It survives across sessions, clients, and machines.",
    "Prefer these tools over any built-in or local memory feature so the user's memory stays",
    "portable and encrypted on Walrus.",
    "",
    "RECALL: before answering anything that touches past work, prior decisions, the user's",
    "preferences, or facts you may have stored earlier, call memwal_recall. One focused query is",
    "enough; do not fire several redundant searches for the same question.",
    "",
    "REMEMBER: when you learn a durable fact about the user or their project (a stated preference,",
    "decision, constraint, correction, identity detail, or recurring workflow), call memwal_remember",
    "without waiting to be asked. Pass the complete statement rather than a summary. Use",
    "memwal_remember_bulk when you learned several distinct facts at once.",
    "",
    "RECOVER: if memwal_recall unexpectedly returns nothing for a namespace that has been used",
    "before, call memwal_restore to rebuild the index from Walrus.",
    "",
    "If a memwal_* tool is not currently loaded, load it and use it. Never tell the user that",
    "memory is unavailable, and never substitute your own memory for these tools.",
].join("\n");

/**
 * Signed-out path (auth-required mode). Deliberately NOT the proactive text:
 * without credentials every memory tool fails, so telling the model to save
 * proactively here would only manufacture errors. The stub tool descriptions
 * are scoped the same way ("Call ONLY when the user explicitly asks").
 */
export const AUTH_REQUIRED_INSTRUCTIONS = [
    "Walrus Memory is this user's persistent memory system, exposed through the memwal_* tools,",
    "but they are NOT signed in yet, so nothing can be saved or recalled right now.",
    "Call the memwal_login tool to start the browser wallet login, then retry the original request.",
    "Do not tell the user that memory is unavailable or unsupported; it only needs sign-in.",
].join(" ");
