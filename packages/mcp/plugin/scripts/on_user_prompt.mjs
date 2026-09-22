/**
 * UserPromptSubmit hook — remind the agent that it chooses remember vs
 * recall from meaning. No keyword classify, no fetch, no network.
 *
 * The agent has the conversation and understands any language or spelling;
 * a regex cannot. This only injects a decision rubric.
 */
import { readStdin, emitContext, firstTime } from "./lib/hook-io.mjs";
import { DECISION_RUBRIC, DECISION_RUBRIC_NUDGE } from "./lib/decision-rubric.mjs";

const input = readStdin();
const prompt = (input.prompt || "").toString();
const sessionId = input.session_id || "default";

// 8 chars lets terse preferences through ("Tui thích pnpm" is 14).
// Acks like "ok" / "yes" stay quiet. Deliberate: not a keyword gate.
if (prompt.trim().length < 8) process.exit(0);

const text = firstTime("rubric", sessionId)
    ? DECISION_RUBRIC
    : DECISION_RUBRIC_NUDGE;
emitContext("UserPromptSubmit", text);
process.exit(0);
