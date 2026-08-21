/**
 * SessionStart hook — announce that Walrus Memory is active and remind the
 * agent how/when to use it. No fetch, no network.
 */
import { readStdin, emitContext } from "./lib/hook-io.mjs";

readStdin(); // drain stdin; we don't need any field today
const ns = process.env.MEMWAL_NAMESPACE || "default";

const context = [
    `Walrus Memory is this user's memory system, exposed via the memwal_* tools (namespace: ${ns}).`,
    "Use it as the PRIMARY place to store and recall durable facts — prefer the memwal_* tools over any built-in or local memory feature, so the user's memory stays portable and persistent on Walrus.",
    "You decide from meaning, in any language or spelling. When the user states a preference, decision, constraint, correction, identity, recurring workflow, or a configuration value such as a hostname, port, region or id, call memwal_remember (or memwal_remember_bulk for several) in that same turn, before you finish replying — do not ask whether to save it, and note that acknowledging it in your reply does not store it. Skip one-off tasks, the current file or bug, and small talk. Before tasks that reference past work or preferences, recall with memwal_recall.",
    "If memwal_recall unexpectedly returns nothing for a namespace you've used before, run memwal_restore to rebuild the index from Walrus.",
].join(" ");

emitContext("SessionStart", context);
process.exit(0);
