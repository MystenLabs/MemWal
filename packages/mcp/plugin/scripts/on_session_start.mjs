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
    "When you learn a durable fact (preference, decision, constraint, correction, identity), save it with memwal_remember (or memwal_remember_bulk for several at once); before tasks that reference past work or the user's preferences, recall with memwal_recall.",
    "If memwal_recall unexpectedly returns nothing for a namespace you've used before, run memwal_restore to rebuild the index from Walrus.",
].join(" ");

emitContext("SessionStart", context);
process.exit(0);
