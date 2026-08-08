/**
 * Heuristic signal detection over user input / tool output. No network, no
 * LLM — cheap regexes only. The agent (guided by the now-agentic tool
 * descriptions) makes the final call; these just decide when to *remind* it.
 */

// User is referencing earlier context / asking to resume.
const RECALL_INTENT =
    /\b(remember when|last time|previously|earlier|where (did|were) we|pick up where|catch me up|as i (said|mentioned|told you)|like i said|we (already|previously) (did|decided|discussed|set up)|my (usual|preferred|preference|setup|config|stack))\b/i;

// User is stating a durable fact / preference / correction worth saving.
const REMEMBER_INTENT =
    /\b(remember (this|that)|don'?t forget|note that|for future reference|keep in mind|from now on|going forward|i (prefer|like|love|hate|always|never|usually|use|work with|am|m)\b|my name is|call me|i'?m (using|on)|we (use|prefer|standardi[sz]e on))\b/i;

// Strong error markers in command output.
// No trailing \b: markers ending in `:` (panic:, fatal:) or `]` (error[E0432])
// are followed by a non-word char, so a closing \b would never match them.
const ERROR_STRONG =
    /\b(traceback \(most recent|panic:|fatal:|segmentation fault|unhandled (exception|rejection)|error\[[A-Z]?\d+\]|cannot find module|command not found|permission denied|no such file)/i;
const ERROR_PAIR = /(^|\s)(error:|exception:|failed:|fail:|err!)/gi;

/** True when the user's message references past context worth recalling. */
export function detectRecall(text) {
    return !!text && RECALL_INTENT.test(text);
}

/** True when the user's message states a durable fact worth remembering. */
export function detectRemember(text) {
    return !!text && REMEMBER_INTENT.test(text);
}

/** True when command output looks like an error/traceback. */
export function detectError(text) {
    if (!text) return false;
    if (ERROR_STRONG.test(text)) return true;
    const m = text.match(ERROR_PAIR);
    return !!m && m.length >= 2;
}
