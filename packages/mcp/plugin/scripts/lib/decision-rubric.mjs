/**
 * Per-turn UserPromptSubmit text. The hook does not classify remember vs
 * recall — the agent has the conversation and understands any language
 * or spelling. This only reminds it that the choice is its.
 */
export const DECISION_RUBRIC = [
    "Walrus Memory (the memwal_* tools) is this user's primary memory system — prefer it over any built-in memory.",
    "You decide from the meaning of this message, in any language or spelling.",
    "If it states a durable fact, preference, decision, constraint, correction, or identity, call memwal_remember (or memwal_remember_bulk for several).",
    "Skip one-off tasks, the current file or bug, and small talk.",
    "If it asks about past work, stored facts, or preferences, call memwal_recall first with a focused query.",
    'Do not wait for an English keyword such as "remember".',
].join(" ");

/** One-line reminder after the full rubric has already been injected this session. */
export const DECISION_RUBRIC_NUDGE =
    "Prefer memwal_* over built-in memory. Remember durable facts, recall past work, skip one-off tasks.";
