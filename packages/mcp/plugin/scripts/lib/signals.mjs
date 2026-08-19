/**
 * Heuristic signal detection over tool output. No network, no LLM — cheap
 * regexes only. Used by PostToolUse to notice command errors. Remember vs
 * recall is the agent's call (see decision-rubric.mjs), not a keyword gate.
 */

// Strong error markers in command output.
// No trailing \b: markers ending in `:` (panic:, fatal:) or `]` (error[E0432])
// are followed by a non-word char, so a closing \b would never match them.
const ERROR_STRONG =
    /\b(traceback \(most recent|panic:|fatal:|segmentation fault|unhandled (exception|rejection)|error\[[A-Z]?\d+\]|cannot find module|command not found|permission denied|no such file)/i;
const ERROR_PAIR = /(^|\s)(error:|exception:|failed:|fail:|err!)/gi;

/** True when command output looks like an error/traceback. */
export function detectError(text) {
    if (!text) return false;
    if (ERROR_STRONG.test(text)) return true;
    const m = text.match(ERROR_PAIR);
    return !!m && m.length >= 2;
}
