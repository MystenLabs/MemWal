/**
 * UserPromptSubmit hook — decide, from the user's input, whether the agent
 * should recall context or save a fact, and inject a short directive saying so.
 *
 * Heuristic only: no fetch, no network. The agent does the actual tool call.
 */
import { readStdin, emitContext, firstTime } from "./lib/hook-io.mjs";
import { detectRecall, detectRemember } from "./lib/signals.mjs";

const input = readStdin();
const prompt = (input.prompt || "").toString();
const sessionId = input.session_id || "default";

// Skip very short prompts (acks, single words) — nothing useful to act on.
if (prompt.trim().length < 20) process.exit(0);

const parts = [];

if (detectRecall(prompt)) {
    parts.push(
        "The user is referencing earlier work or context. Before answering, call memwal_recall (Walrus Memory) with a focused query — use the memwal_* tools, not any built-in memory, so recall stays portable."
    );
}

if (detectRemember(prompt)) {
    parts.push(
        "The user just stated a durable fact or preference. Save it with memwal_remember (or memwal_remember_bulk for several distinct facts) — prefer the memwal_* tools over any built-in memory so the fact persists on Walrus across sessions and agents."
    );
}

// When no strong signal fired, inject the general rubric once per session so
// the agent knows the tools exist, when to reach for them, and to prefer them
// over any built-in memory feature.
if (parts.length === 0 && firstTime("rubric", sessionId)) {
    parts.push(
        "Walrus Memory (the memwal_* tools) is this user's primary memory system — prefer it over any built-in memory. Call memwal_recall proactively when the user references past work, decisions, or preferences; save durable facts with memwal_remember (or memwal_remember_bulk for several) as you learn them — you don't need to be asked."
    );
}

emitContext("UserPromptSubmit", parts.join(" "));
process.exit(0);
