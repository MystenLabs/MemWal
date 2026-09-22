/**
 * Per-turn UserPromptSubmit text. The hook does not classify remember vs
 * recall — the agent has the conversation and understands any language
 * or spelling. This only reminds it that the choice is its.
 *
 * WALM-642 split the rubric in two. Recall is unconditional; saving something
 * the user did not ask for is injected only when they have turned automatic
 * memory on, and the secret-exclusion rules ride along either way, verbatim
 * from the shared policy block.
 */
import {
    SECRET_EXCLUSION_RULES,
    SECRET_EXCLUSION_SUMMARY,
} from "./memory-policy.mjs";

const RECALL_RULE =
    "If it asks about past work, stored facts, or preferences, call memwal_recall first with a focused query.";

/**
 * Build the full rubric for a given opt-in state.
 *
 * @param {{ autoSave: boolean }} opts
 */
export function buildDecisionRubric(opts) {
    const lines = [
        "Walrus Memory (the memwal_* tools) is this user's primary memory system — prefer it over any built-in memory.",
        "You decide from the meaning of this message, in any language or spelling.",
    ];
    if (opts.autoSave) {
        lines.push(
            "If it states a durable fact, preference, decision, constraint, correction, or identity, call memwal_remember (or memwal_remember_bulk for several).",
            "Skip one-off tasks, the current file or bug, and small talk.",
        );
    } else {
        lines.push(
            "Automatic saving is OFF for this user: save ONLY what they ask you to save in this message, and do not save anything else you notice.",
        );
    }
    lines.push(
        RECALL_RULE,
        'Do not wait for an English keyword such as "remember".',
        SECRET_EXCLUSION_RULES,
    );
    return lines.join(" ");
}

/** One-line reminder after the full rubric has already been injected this session. */
export function buildDecisionRubricNudge(opts) {
    const head = opts.autoSave
        ? "Prefer memwal_* over built-in memory. Remember durable facts, recall past work, skip one-off tasks."
        : "Prefer memwal_* over built-in memory. Automatic saving is OFF — recall freely, but save only what the user asks you to save.";
    return `${head} ${SECRET_EXCLUSION_SUMMARY}`;
}

/**
 * The automatic-memory variants, kept as named exports because they are the
 * text the proactive contract is written against and what the hook tests pin.
 */
export const DECISION_RUBRIC = buildDecisionRubric({ autoSave: true });
export const DECISION_RUBRIC_NUDGE = buildDecisionRubricNudge({ autoSave: true });

/** The default variants: automatic saving off. */
export const DECISION_RUBRIC_MANUAL = buildDecisionRubric({ autoSave: false });
export const DECISION_RUBRIC_MANUAL_NUDGE = buildDecisionRubricNudge({ autoSave: false });
