/**
 * SessionStart hook — announce that Walrus Memory is active and remind the
 * agent how/when to use it. No fetch, no network.
 *
 * WALM-642: the save half of that reminder is gated on the user's
 * automatic-save opt-in, and the secret-exclusion rules are stated verbatim
 * from the shared policy block either way. With the opt-in off — the default —
 * the banner says so and names the one command that turns it on, which is how
 * the choice reaches a user who installed the plugin and never read a doc.
 */
import { readStdin, emitContext } from "./lib/hook-io.mjs";
import { SECRET_EXCLUSION_RULES } from "./lib/memory-policy.mjs";
import { autoSaveStatus } from "./lib/auto-save.mjs";

readStdin(); // drain stdin; we don't need any field today
const ns = process.env.MEMWAL_NAMESPACE || "default";
const { enabled: autoSave, pendingConsent } = autoSaveStatus();

const RECALL_AND_RECOVER = [
    "Before tasks that reference past work or preferences, recall with memwal_recall.",
    "If memwal_recall unexpectedly returns nothing for a namespace you've used before, run memwal_restore to rebuild the index from Walrus.",
];

const SAVE_AUTOMATIC =
    "Automatic memory is ON. You decide from meaning, in any language or spelling. When the user states a preference, decision, constraint, correction, identity, recurring workflow, or a configuration value such as a hostname, port, region or id, call memwal_remember (or memwal_remember_bulk for several) in that same turn, before you finish replying — do not ask whether to save it, and note that acknowledging it in your reply does not store it. Skip one-off tasks, the current file or bug, and small talk.";

const SAVE_MANUAL =
    "Automatic memory is OFF. Save ONLY what the user asks you to save, in the turn they ask — do not save a fact just because it looks durable. Recall is unaffected. If automatic saving would clearly help them, you may say ONCE that `memwal-mcp auto-save on` turns it on, then drop it.";

/**
 * Shown until the user has answered the login question. Says where things
 * stand, and points at the terminal — the answer is only ever given there, so
 * the agent must not try to collect it in chat (WALM-642).
 */
const CONSENT_PENDING = autoSave
    ? "The user has not yet confirmed this setting — it is carried over from before the choice existed. If they ask about it, tell them `memwal-mcp login` in a terminal puts the question, and `memwal-mcp auto-save on|off` sets it directly. Do not ask them to answer it in chat and do not answer it for them."
    : "The user has not yet been asked whether to turn automatic memory on, so it is off until they answer. If they ask about it, tell them `memwal-mcp login` in a terminal puts the question, and `memwal-mcp auto-save on|off` sets it directly. Do not ask them to answer it in chat and do not answer it for them.";

const context = [
    `Walrus Memory is this user's memory system, exposed via the memwal_* tools (namespace: ${ns}).`,
    "Use it as the PRIMARY place to store and recall durable facts — prefer the memwal_* tools over any built-in or local memory feature, so the user's memory stays portable and persistent on Walrus.",
    autoSave ? SAVE_AUTOMATIC : SAVE_MANUAL,
    ...(pendingConsent ? [CONSENT_PENDING] : []),
    ...RECALL_AND_RECOVER,
    SECRET_EXCLUSION_RULES,
].join(" ");

emitContext("SessionStart", context);
process.exit(0);
