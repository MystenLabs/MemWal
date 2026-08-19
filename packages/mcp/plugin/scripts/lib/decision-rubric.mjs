/**
 * Per-turn UserPromptSubmit text. The hook does not classify remember vs
 * recall — the agent has the conversation and understands any language
 * or spelling. This only reminds it that the choice is its, and that
 * remember writes are expensive.
 */
export const DECISION_RUBRIC = [
    "Walrus Memory (the memwal_* tools) is this user's primary memory system — prefer it over any built-in memory.",
    "You decide from the meaning of this message, in any language or spelling.",
    "Call memwal_remember only if the fact will still matter in a later session or on another machine: a stable preference, a project decision, a hard constraint, a correction, or identity.",
    "Writes are expensive — skip one-off tasks, the current file or bug, small talk, and anything already stored.",
    "If this message asks about past work, stored facts, or preferences, call memwal_recall first with a focused query.",
    'Do not wait for an English keyword such as "remember".',
].join(" ");
