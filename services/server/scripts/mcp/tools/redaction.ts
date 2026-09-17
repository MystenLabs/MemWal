/**
 * Credential redaction for the memory write path (WALM-642).
 *
 * Every tool that forwards free text to the SDK — `memwal_remember`,
 * `memwal_remember_bulk`, `memwal_analyze` — runs its input through
 * `sanitizeFact` FIRST. The model-facing rules in `memory-policy.ts` are
 * guidance; this module is the backstop that does not depend on a model having
 * read them. Walrus storage is append-only and immutable: a secret that reaches
 * it cannot be deleted, so the check has to sit in front of the write rather
 * than behind it.
 *
 * Two shapes of answer:
 *
 *   - REDACT (the common case, and what the ticket asks for): a message that
 *     mixes a durable preference with a credential keeps the preference and
 *     loses only the credential span, replaced by `[redacted:<kind>]`. Dropping
 *     the whole fact would lose the thing the user actually wanted stored.
 *   - REFUSE: nothing safe is left, the user said not to save it, or the text
 *     is plainly pasted third-party material. The caller forwards nothing.
 *
 * ── False positives, deliberately ───────────────────────────────────────────
 * The patterns below are SHAPE-based, not entropy-based. That is a choice, and
 * it costs recall:
 *
 *   - There is no free-standing "long random-looking string" rule. MemWal's own
 *     durable facts are exactly that shape — Walrus blob ids (43-char
 *     base64url), Sui object and account ids (`0x` + 64 hex), git SHAs (40 hex),
 *     content digests. A generic high-entropy rule would redact the product's
 *     primary nouns. The one entropy rule that survived
 *     (`HIGH_ENTROPY_SECRET`) demands ≥64 characters AND mixed case AND a
 *     digit, which excludes every one of those (all-lowercase hex, or shorter),
 *     while still catching a raw base64 key blob.
 *   - `password:`-style assignments redact whatever follows the separator, so
 *     "password: ask Marta" loses "ask Marta". Over-redacting a sentence about
 *     a credential is cheap; under-redacting the credential is permanent.
 *   - Quoted-content detection only fires on unambiguous pastes (a fenced
 *     block, a multi-line `>` quotation, or a ≥200-char fully quoted passage).
 *     A short quoted sentence is left to the model-facing rules, because an
 *     agent legitimately quotes the user's own words back when saving a fact.
 *
 * Nothing here logs, echoes, or returns the matched secret. Callers get the
 * redacted text and the KINDS that were removed — never the values.
 */

export type RedactionKind =
    | "url-credentials"
    | "vendor-api-key"
    | "private-key-block"
    | "jwt"
    | "credential-assignment"
    | "auth-header"
    | "seed-phrase"
    | "high-entropy-secret";

/** Why a text was refused outright instead of redacted. */
export type RefusalReason =
    /** The user said not to save it. */
    | "no-save-directive"
    /** After redaction there was no fact left — the text was only a secret. */
    | "credential-only"
    /** Pasted third-party material, not a fact about this user. */
    | "pasted-content";

export interface SanitizedText {
    /** Text safe to forward. Empty when `refusal` is set. */
    text: string;
    /** True when the text was changed or refused. */
    changed: boolean;
    /** Kinds removed, first-seen order. Never contains a secret value. */
    kinds: RedactionKind[];
    /** Number of spans replaced. */
    count: number;
    /** Set when the caller must forward nothing at all. */
    refusal?: RefusalReason;
}

function placeholder(kind: RedactionKind): string {
    return `[redacted:${kind}]`;
}

/**
 * An explicit instruction not to save, from the user.
 *
 * Deliberately demands a demonstrative object ("this", "that", "it"): without
 * it, "remember that I don't save screenshots to the Desktop" — a perfectly
 * good durable preference — would be refused as a do-not-save directive.
 */
const NO_SAVE_DIRECTIVE =
    /\b(?:do\s+not|don'?t|dont|never|please\s+do\s+not|please\s+don'?t)\s+(?:save|store|remember|record|keep|persist|log)\s+(?:this|that|it|these|those|any\s+of\s+(?:this|that|it))\b/i;

/** The idiom, which carries the same instruction without naming saving. */
const OFF_THE_RECORD = /\boff[-\s]the[-\s]record\b/i;

/**
 * PEM private key blocks. The second pattern is not redundant: a paste that was
 * cut off mid-key has a BEGIN line and no END line, and without the open-ended
 * form the key body would survive untouched.
 */
const PEM_CLOSED =
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g;

/**
 * `scheme://user:password@host` — the exact shape in the WALM-642 repro, and
 * the shape of every connection string that carries its own credentials
 * (`postgres://`, `mongodb+srv://`, `amqp://`, `redis://`, ...).
 *
 * Only the userinfo is replaced: scheme, host, port and path are the part of a
 * connection string worth remembering.
 */
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/g;

/**
 * Authorization / cookie headers, value dropped, header name kept.
 *
 * The cookie value stops at whitespace rather than at the end of the line, and
 * then continues across `;`-separated pairs. A real header (`Cookie: a=1; b=2`)
 * is matched whole; a header quoted mid-sentence loses the cookie and not the
 * rest of the sentence. Cookie values are token-shaped by spec, so the only
 * thing this gives up is a value that contains a raw space — which is not
 * legal in one anyway.
 */
const AUTH_HEADER =
    /\b((?:proxy-)?authorization)(\s*[:=]\s*)(?:bearer|basic|token|digest)?\s*\S+/gi;
const COOKIE_HEADER =
    /\b((?:set-)?cookie)(\s*[:=]\s*)[^\s;]+(?:\s*;\s*[^\s;]+)*/gi;

/**
 * `key=value` / `key: value` where the key names a credential.
 *
 * The separator must follow the keyword immediately, which is what keeps
 * ordinary prose out: "my password manager is 1Password" has no separator after
 * "password" and does not match.
 */
const CREDENTIAL_ASSIGNMENT =
    /\b(passwords?|passwd|pwd|passphrases?|api[_-]?keys?|apikeys?|secret[_-]?keys?|client[_-]?secrets?|secrets?|access[_-]?tokens?|refresh[_-]?tokens?|auth[_-]?tokens?|bearer[_-]?tokens?|tokens?|private[_-]?keys?|credentials?)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s,;]+)/gi;

/**
 * Vendor-prefixed keys. Each prefix is issued by exactly one service and never
 * appears at the head of ordinary text, so these are the highest-confidence
 * patterns in the file — no context needed.
 */
const VENDOR_KEYS: RegExp[] = [
    /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
    /\bsk-proj-[A-Za-z0-9_-]{16,}/g, // OpenAI project
    /\bsk-[A-Za-z0-9]{20,}/g, // OpenAI classic
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
    /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API
    /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
    /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
    /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
    /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
    /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g, // Shopify
    /\bdop_v1_[a-f0-9]{64}\b/g, // DigitalOcean
    /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
];

/** Three base64url segments — a signed JWT, whatever it encodes. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/**
 * A BIP-39 mnemonic, gated on the user naming it.
 *
 * Twelve consecutive lowercase words is also what an ordinary sentence looks
 * like, so the words alone prove nothing; "seed phrase" / "mnemonic" /
 * "recovery phrase" in front of them is what makes the match safe. A mnemonic
 * pasted with no label is left to `SECRET_EXCLUSION_RULES` — carrying the
 * 2048-word list here to catch it would be a lot of weight for a case the model
 * rules already cover.
 */
const SEED_PHRASE =
    /\b((?:seed|recovery|secret|mnemonic)\s+(?:phrase|words)|mnemonic)(\s*(?:is|are|:|=)?\s*)((?:[a-z]{3,8}[ \t]+){11,23}[a-z]{3,8})\b/gi;

/**
 * A ≥64-character base64/base64url run carrying lower case, upper case AND a
 * digit. See the false-positive note at the top: the three conditions together
 * are what exclude blob ids, Sui addresses, git SHAs and hex digests, all of
 * which are shorter, single-case, or both.
 */
const HIGH_ENTROPY_CANDIDATE = /\b[A-Za-z0-9+/_-]{64,}={0,2}/g;

function looksLikeSecretBlob(token: string): boolean {
    const body = token.replace(/=+$/, "");
    if (body.length < 64) return false;
    if (!/[a-z]/.test(body)) return false;
    if (!/[A-Z]/.test(body)) return false;
    if (!/[0-9]/.test(body)) return false;
    // Hex is single-case by convention and covers digests, SHAs and Sui ids;
    // a mixed-case hex string is still far more likely a digest than a key.
    if (/^[0-9a-fA-F]+$/.test(body)) return false;
    return true;
}

/**
 * Unambiguously pasted third-party material.
 *
 * Narrow on purpose — see the false-positive note. An agent saving a fact
 * routinely quotes the user's own sentence, so a short quoted string is NOT
 * treated as a paste.
 */
function isPastedContent(text: string): boolean {
    const s = text.trim();
    if (/^```[\s\S]*```$/.test(s)) return true;
    const lines = s.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length >= 2 && lines.every((l) => /^\s*>/.test(l))) return true;
    if (s.length >= 200 && /^["“][\s\S]*["”]$/.test(s)) return true;
    return false;
}

/**
 * Is there still a fact here once the placeholders are taken out?
 *
 * Three words of two or more letters. "sk-live-..." on its own redacts to a
 * bare placeholder and has none; "I keep the staging key in 1Password,
 * api_key=..." keeps its sentence and has plenty.
 */
function hasSalvageableContent(text: string): boolean {
    const withoutPlaceholders = text.replace(/\[redacted:[a-z-]+\]/g, " ");
    const words = withoutPlaceholders.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    return words.length >= 3;
}

/**
 * Strip credentials from one piece of text before it is forwarded to the SDK.
 *
 * Pure, synchronous and side-effect free: no logging, no I/O. The secret exists
 * only in the caller's argument and never leaves this function.
 */
export function sanitizeFact(input: string): SanitizedText {
    const original = input ?? "";

    if (NO_SAVE_DIRECTIVE.test(original) || OFF_THE_RECORD.test(original)) {
        return {
            text: "",
            changed: true,
            kinds: [],
            count: 0,
            refusal: "no-save-directive",
        };
    }

    if (isPastedContent(original)) {
        return {
            text: "",
            changed: true,
            kinds: [],
            count: 0,
            refusal: "pasted-content",
        };
    }

    const kinds: RedactionKind[] = [];
    let count = 0;
    const hit = (kind: RedactionKind) => {
        if (!kinds.includes(kind)) kinds.push(kind);
        count += 1;
        return placeholder(kind);
    };

    let text = original;

    // PEM first: it spans lines, and running the line-oriented patterns over a
    // key body would shred it into several partial matches instead of one.
    text = text.replace(PEM_CLOSED, () => hit("private-key-block"));
    text = text.replace(PEM_OPEN, () => hit("private-key-block"));

    text = text.replace(URL_USERINFO, (_m, scheme: string) => {
        hit("url-credentials");
        return `${scheme}${placeholder("url-credentials")}@`;
    });

    text = text.replace(AUTH_HEADER, (_m, name: string, sep: string) => {
        hit("auth-header");
        return `${name}${sep}${placeholder("auth-header")}`;
    });
    text = text.replace(COOKIE_HEADER, (_m, name: string, sep: string) => {
        hit("auth-header");
        return `${name}${sep}${placeholder("auth-header")}`;
    });

    // Before the vendor patterns, so `api_key=sk-...` is reported once as an
    // assignment rather than twice.
    text = text.replace(CREDENTIAL_ASSIGNMENT, (_m, key: string, sep: string) => {
        hit("credential-assignment");
        return `${key}${sep}${placeholder("credential-assignment")}`;
    });

    for (const pattern of VENDOR_KEYS) {
        text = text.replace(pattern, () => hit("vendor-api-key"));
    }

    text = text.replace(JWT, () => hit("jwt"));

    text = text.replace(SEED_PHRASE, (_m, label: string, sep: string) => {
        hit("seed-phrase");
        return `${label}${sep}${placeholder("seed-phrase")}`;
    });

    text = text.replace(HIGH_ENTROPY_CANDIDATE, (token: string) =>
        looksLikeSecretBlob(token) ? hit("high-entropy-secret") : token,
    );

    if (count === 0) {
        return { text: original, changed: false, kinds: [], count: 0 };
    }

    // Collapse the whitespace a removed block leaves behind, so the stored fact
    // does not carry the shape of what was taken out.
    text = text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();

    if (!hasSalvageableContent(text)) {
        return {
            text: "",
            changed: true,
            kinds,
            count,
            refusal: "credential-only",
        };
    }

    return { text, changed: true, kinds, count };
}

/** Human-readable reason, for the note handed back to the agent. */
export function refusalMessage(reason: RefusalReason): string {
    switch (reason) {
        case "no-save-directive":
            return "the text says not to save it";
        case "credential-only":
            return "the text was a credential with no fact around it";
        case "pasted-content":
            return "the text is pasted third-party content, not a fact about the user";
    }
}

/**
 * The line appended to a tool result when something was removed.
 *
 * Names the kinds and nothing else — an agent needs to know a redaction
 * happened so it does not tell the user the whole line was stored, and it never
 * needs the value back.
 */
export function redactionNotice(kinds: RedactionKind[], count: number): string {
    if (count === 0) return "";
    return (
        `Note: ${count} credential span(s) were removed before saving ` +
        `(${kinds.join(", ")}). What was stored is the redacted text — the secret ` +
        `was never sent to Walrus Memory and is not logged. Tell the user the ` +
        `credential was left out; do not re-send it.`
    );
}

/**
 * The line for a text that was not saved at all.
 */
export function refusalNotice(reason: RefusalReason): string {
    return (
        `NOT SAVED: ${refusalMessage(reason)}. Nothing was written to Walrus ` +
        `Memory. Do not retry this text — if there is a durable fact in it, ` +
        `restate the fact without the sensitive part and save that instead.`
    );
}
