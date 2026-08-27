/**
 * User-facing copy for the sign-in lifecycle.
 *
 * The same events are reported from two places — the auth-required stub
 * (signed out) and the bridge (signed in) — and the wording had already
 * drifted between them. Keeping the strings here means one voice regardless
 * of which mode the user happens to be in.
 */

/** What a completed sign-in produced, as the user needs it described. */
export interface LoginSuccessInfo {
    accountId: string;
    delegateAddress: string;
    /** The file `saveCreds` actually wrote — project-local or global. Never a
     * hardcoded `~/.memwal/credentials.json`: which one it lands in is exactly
     * the confusion behind GH #628, so the copy states the resolved path. */
    credentialsPath: string;
}

/** What a sign-in prompt needs to describe the flow accurately. */
export interface LoginPromptInfo {
    /** The connect URL the user must open. */
    url: string;
    /** Where credentials will land — resolved, never assumed to be global. */
    credentialsPath: string;
    /** True when credentials already exist, so signing in REPLACES them. */
    signedIn: boolean;
}

/**
 * The `memwal_login` tool result, for both modes.
 *
 * The URL appears three times — plain, fenced, and as a link — on purpose.
 * Some clients paraphrase tool output aggressively, and repeating it in three
 * forms means at least one survives into what the user actually sees. Without
 * the URL the user cannot proceed at all, so this is the one place where
 * redundancy beats tidiness.
 */
export function loginPrompt(info: LoginPromptInfo): string {
    return [
        `## ⚠️ ACTION REQUIRED: User must click this URL to sign in`,
        ``,
        `**URL:** ${info.url}`,
        ``,
        "```",
        info.url,
        "```",
        ``,
        `[Click here to open Walrus Memory sign-in](${info.url})`,
        ``,
        `**IMPORTANT for the assistant**: do NOT summarize or omit the URL above.`,
        `The user CANNOT proceed without seeing the exact URL. Surface it verbatim`,
        `in your reply, then explain the steps:`,
        ``,
        `1. Open the URL in any browser (it may have already opened automatically)`,
        `2. Click **Connect Sui Wallet** and approve the on-chain \`add_delegate_key\` transaction`,
        `3. Once "Connected" appears in the browser, retry the original request — the other memwal_* tools will then have credentials at \`${info.credentialsPath}\``,
        ...(info.signedIn
            ? [
                  ``,
                  `**Note:** you are already signed in. Completing this replaces the stored delegate key at \`${info.credentialsPath}\` with the new wallet's.`,
              ]
            : []),
        ``,
        `_The login link stays valid for 5 minutes. If it expires, call \`memwal_login\` again to get a fresh URL._`,
    ].join("\n");
}

/** Sui ids are 66 characters; showing one whole swamps the message. */
function shortId(id: string): string {
    return id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

/**
 * Banner prefixed onto the first tool result after a sign-in completes.
 *
 * Deliberately a ONE-SHOT, unlike {@link loginFailureNotice}'s repeat-until-
 * fixed behaviour: a failed sign-in is a state that persists until the user
 * acts, but a successful one is an event. Repeating it on every recall would
 * be noise on top of every result the user asked for.
 */
export function loginSuccessNotice(info: LoginSuccessInfo): string {
    return [
        "✅ Signed in to Walrus Memory.",
        "",
        `Account:  ${shortId(info.accountId)}`,
        `Delegate: ${shortId(info.delegateAddress)}`,
        `Saved to: ${info.credentialsPath}`,
        "",
        "This connection is now authenticated — no client restart needed.",
        "",
        "---",
        "",
    ].join("\n");
}

/**
 * The `notifications/message` twin of the banner, mirroring the warning the
 * failure path already sends. Clients differ in which surface they show —
 * some render notifications inline, others drop them — so the confirmation
 * goes out on both and neither depends on the other.
 */
export function loginSuccessNotification(info: LoginSuccessInfo): string {
    return (
        `Walrus Memory sign-in complete — account ${shortId(info.accountId)}, ` +
        `credentials saved to ${info.credentialsPath}.`
    );
}
