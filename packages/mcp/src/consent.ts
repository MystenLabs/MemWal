/**
 * The automatic-memory consent question (WALM-642).
 *
 * Asked at interactive login and NOWHERE else. Deliberately not an MCP tool,
 * not a tool description, not an instruction, and not anything a model can
 * reach: a model answering on the user's behalf is not consent, and an
 * agent-shaped surface for this question would be exactly that. The only caller
 * is `main()` in index.ts, behind `process.stdin.isTTY`.
 *
 * Login is the gate because MemWal is unusable without it, so every real user
 * passes through it once, and it is already a moment that requires a terminal.
 *
 * On the wording — it is the substance of this change, not decoration:
 *
 *   - It names the consequence ("writes it to your memory without asking each
 *     time"), not the feature. Someone should be able to picture what happens
 *     to them, in their own session, from reading it.
 *   - Permanence leads, because it is the fact that changes the answer. Walrus
 *     is immutable: you can stop saving new memories but you cannot take back
 *     one already saved. Burying that under "we value your privacy" would make
 *     this a cookie banner, which it is not.
 *   - The redaction claim is deliberately hedged. `redaction.ts` documents real
 *     residual gaps — an unlabelled hex secret, a bare BIP-39 word run — so
 *     "safety net, not a guarantee" is the accurate claim and must stay. Saying
 *     more would be selling a promise the code does not make.
 *   - Declining is free and is stated as a normal choice, not a warning. A "no"
 *     is recorded once and never asked again.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** The prompt body, everything above the input line. */
export const CONSENT_PROMPT = [
    "",
    "MemWal can save things about you automatically.",
    "",
    "What that means: when you state a preference, a decision, or a setting in",
    'chat — "I prefer pnpm", "we deploy from dev", "the relayer is at X" —',
    "MemWal writes it to your memory without asking each time, so it is there",
    "in your next session and in every other client you use.",
    "",
    "Before you choose:",
    "",
    "  - Saved memories are permanent. They go to Walrus, which is immutable",
    "    storage. You can stop saving new ones at any time, but you cannot",
    "    delete one that is already saved.",
    "  - They are encrypted to your account. Only your delegate key reads them.",
    "  - MemWal strips obvious credentials — API keys, tokens, passwords,",
    "    private keys — before saving. Treat that as a safety net, not a",
    "    guarantee: do not paste secrets into a session with this on.",
    "",
    "  [1] Save automatically      recommended, this is what MemWal is for",
    '  [2] Only save when I ask    nothing is saved unless you say "remember this"',
    "",
    "Change this any time with `memwal-mcp auto-save on|off`.",
    "See what is stored with `memwal_recall`.",
    "",
].join("\n");

/** The input line. Enter alone takes the recommended option. */
export const CONSENT_QUESTION = "Your choice [1/2]: ";

/** What to say when the answer is neither 1 nor 2. */
export const CONSENT_REPROMPT =
    "Please answer 1 or 2 (or press Enter for 1).";

/**
 * Map one line of input to an answer.
 *
 * Empty (a bare Enter) accepts option 1. Anything that is not 1 or 2 returns
 * `null`, which means re-ask — never "assume the recommended one", because a
 * typo is not an answer to a question about permanent storage.
 */
export function interpretConsentAnswer(raw: string): boolean | null {
    const v = raw.trim().toLowerCase();
    if (v === "") return true;
    if (v === "1") return true;
    if (v === "2") return false;
    return null;
}

/**
 * Ask the question on a terminal and resolve to the answer.
 *
 * Resolves `null` — meaning "no answer given" — if the input stream ends first
 * (Ctrl-D, a closed pipe, a killed terminal). The caller leaves the state unset
 * in that case and asks again next time rather than recording a choice the user
 * never made.
 *
 * Streams are injected so this is testable without a pty; `main()` passes the
 * real stdin and stderr. Output goes to stderr because stdout belongs to the
 * MCP protocol on every other path in this package.
 */
export async function askAutoSaveConsent(opts: {
    input: Readable;
    output: Writable;
    /** Guard against an accidental headless call. Defaults to requiring a TTY. */
    isTTY?: boolean;
}): Promise<boolean | null> {
    // A prompt with nobody in front of it is a hang, not a question. The
    // caller already checks this; the second check is here because the cost of
    // getting it wrong is an MCP server that never finishes starting.
    if (opts.isTTY === false) return null;

    opts.output.write(`${CONSENT_PROMPT}\n`);

    const rl = createInterface({ input: opts.input, terminal: false });
    try {
        opts.output.write(CONSENT_QUESTION);
        // The interface's async iterator, rather than a promise per `line`
        // event: attaching a fresh listener after each answer drops any line
        // that arrived while nothing was listening, which deadlocks the re-ask
        // path the moment input is buffered rather than typed.
        for await (const line of rl) {
            const answer = interpretConsentAnswer(line);
            if (answer !== null) return answer;
            opts.output.write(`${CONSENT_REPROMPT}\n`);
            opts.output.write(CONSENT_QUESTION);
        }
        // Exhausted without an answer: Ctrl-D, a closed pipe, a killed
        // terminal. Not a choice, and not recorded as one.
        opts.output.write("\n");
        return null;
    } finally {
        rl.close();
    }
}

/** What is printed once the answer is in. */
export function consentOutcomeNotice(enabled: boolean, path: string): string {
    return enabled
        ? "Automatic memory is ON. MemWal will save durable facts as you state them. " +
              `Turn it off any time with \`memwal-mcp auto-save off\`. (${path})`
        : "Automatic memory is OFF. Nothing is saved unless you ask for it — " +
              '"remember this" still works, and so does recall. ' +
              `Turn it on any time with \`memwal-mcp auto-save on\`. (${path})`;
}
