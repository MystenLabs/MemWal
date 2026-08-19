/**
 * UserPromptSubmit hook — remind the agent that it chooses remember vs
 * recall from meaning. No keyword classify, no fetch, no network.
 *
 * The agent has the conversation and understands any language or spelling;
 * a regex cannot. This only injects a decision rubric.
 */
import { readStdin, emitContext } from "./lib/hook-io.mjs";
import { DECISION_RUBRIC } from "./lib/decision-rubric.mjs";

const input = readStdin();
const prompt = (input.prompt || "").toString();

// Skip very short prompts (acks, single words) — nothing useful to act on.
if (prompt.trim().length < 20) process.exit(0);

emitContext("UserPromptSubmit", DECISION_RUBRIC);
process.exit(0);
