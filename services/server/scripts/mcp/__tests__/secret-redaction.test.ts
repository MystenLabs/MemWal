/**
 * Unit coverage for the credential redactor (WALM-642).
 *
 * The write-path tests next door prove the three tools call this. These prove
 * what it does, and — just as important — what it leaves alone: Walrus storage
 * is append-only, so a false negative is permanent, but a false positive
 * silently destroys the fact the user asked to keep. Both directions are pinned
 * here.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
    sanitizeFact,
    redactionNotice,
    refusalNotice,
    type RedactionKind,
} from "../tools/redaction.js";

/** Assert a secret is gone, the surrounding fact survived, and the kind is named. */
function assertRedacted(
    input: string,
    secret: string,
    kind: RedactionKind,
    keeps: string[],
): string {
    const out = sanitizeFact(input);
    assert.equal(out.refusal, undefined, `unexpectedly refused: ${input}`);
    assert.ok(out.changed, `nothing was redacted in: ${input}`);
    assert.ok(
        !out.text.includes(secret),
        `the secret survived redaction (kind=${kind})`,
    );
    assert.ok(out.kinds.includes(kind), `expected kind ${kind}, got ${out.kinds}`);
    for (const keep of keeps) {
        assert.ok(out.text.includes(keep), `lost "${keep}" from: ${input}`);
    }
    return out.text;
}

// ── the shapes that must never reach storage ────────────────────────────────

test("a connection string keeps its host and loses its credentials", () => {
    // The WALM-642 repro, almost verbatim: a preference stated next to a URL
    // carrying a password.
    const text = assertRedacted(
        "I prefer dark mode, and the staging db is postgres://admin:hunter2@db.internal:5432/app",
        "hunter2",
        "url-credentials",
        ["I prefer dark mode", "db.internal:5432/app", "postgres://"],
    );
    assert.ok(!text.includes("admin:hunter2"));
});

test("vendor-prefixed API keys are recognised without any context", () => {
    const cases: Array<[string, string]> = [
        ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "sk-ant"],
        ["sk-abcdefghijklmnopqrstuvwxyz0123", "openai"],
        ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github"],
        ["github_pat_11ABCDEFG0abcdefghijklmnop", "github fine-grained"],
        ["AKIAIOSFODNN7EXAMPLE", "aws"],
        ["xoxb-1234567890-abcdefghij", "slack"],
        ["glpat-abcdefghij0123456789", "gitlab"],
    ];
    for (const [secret, label] of cases) {
        assertRedacted(
            `My deploy notes: the CI runner uses ${secret} for pushes`,
            secret,
            "vendor-api-key",
            ["My deploy notes", "CI runner"],
        );
        assert.ok(label);
    }
});

test("a PEM private key is removed whole, terminated or not", () => {
    const body = "MIIEowIBAAKCAQEAx7Vk9mJ0ZwQ3\nabcdefghijklmnopqrstuvwxyz0123456789\n";
    const closed =
        `Deploy key for the box:\n-----BEGIN RSA PRIVATE KEY-----\n${body}-----END RSA PRIVATE KEY-----\nIt lives in 1Password.`;
    const out = assertRedacted(closed, body.trim(), "private-key-block", ["Deploy key"]);
    assert.ok(!out.includes("BEGIN RSA PRIVATE KEY"));

    // A paste that was cut off has no END line. The body must still go.
    const truncated = `Deploy key for the box:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`;
    const cut = sanitizeFact(truncated);
    assert.ok(!cut.text.includes("MIIEowIBAAKCAQEAx7Vk9mJ0ZwQ3"));
    assert.ok(cut.kinds.includes("private-key-block"));
});

test("a JWT is removed", () => {
    const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assertRedacted(
        `Our session tokens look like ${jwt} and expire hourly`,
        jwt,
        "jwt",
        ["Our session tokens", "expire hourly"],
    );
});

test("credential assignments lose the value and keep the key name", () => {
    for (const [line, secret] of [
        ["password=hunter2", "hunter2"],
        ["api_key: abc123def456", "abc123def456"],
        ['token = "t0ps3cr3t-value"', "t0ps3cr3t-value"],
        ["client_secret:swordfish99", "swordfish99"],
    ] as Array<[string, string]>) {
        const out = assertRedacted(
            `My local override file has ${line} and I never commit it`,
            secret,
            "credential-assignment",
            ["local override file", "never commit it"],
        );
        assert.ok(/redacted:credential-assignment/.test(out));
    }
});

test("authorization and cookie headers are removed", () => {
    assertRedacted(
        "To call the API: Authorization: Bearer abc123xyz789 — then GET /v1/me",
        "abc123xyz789",
        "auth-header",
        ["To call the API", "/v1/me"],
    );
    assertRedacted(
        "The dashboard needs Cookie: session=9f8e7d6c5b4a3 to load my profile",
        "9f8e7d6c5b4a3",
        "auth-header",
        ["The dashboard needs", "to load my profile"],
    );
});

test("a labelled seed phrase is removed", () => {
    const words =
        "abandon ability able about above absent absorb abstract absurd abuse access accident";
    assertRedacted(
        `My wallet recovery phrase is ${words} and the wallet is on Sui mainnet`,
        words,
        "seed-phrase",
        ["My wallet", "Sui mainnet"],
    );
});

test("a long mixed-case base64 blob is removed", () => {
    const blob =
        "QWxhZGRpbjpvcGVuIHNlc2FtZQBcdefGHIjklMNOpqrSTUvwxYZ0123456789abcDEF0123";
    assertRedacted(
        `The signing material is ${blob} which I keep in the vault`,
        blob,
        "high-entropy-secret",
        ["The signing material", "keep in the vault"],
    );
});

// ── the shapes that must survive untouched ──────────────────────────────────

test("a plain preference passes through byte-for-byte", () => {
    // The single most important assertion in this file: the ordinary case must
    // be indistinguishable from having no redactor at all.
    for (const fact of [
        "I always use pnpm, and TypeScript strict mode on every project.",
        "Tui luôn dùng pnpm và order cafe là matcha oat latte.",
        "Deploy to staging on Thursdays, never on Friday afternoons.",
        "My password manager is 1Password and I rotate keys every quarter.",
        "The API key for that service is stored in Vault, not in the repo.",
    ]) {
        const out = sanitizeFact(fact);
        assert.equal(out.text, fact, `changed a clean fact: ${fact}`);
        assert.equal(out.changed, false);
        assert.equal(out.count, 0);
        assert.deepEqual(out.kinds, []);
        assert.equal(out.refusal, undefined);
    }
});

test("the identifiers MemWal itself stores are not mistaken for secrets", () => {
    // A generic entropy rule would eat every one of these, which is why there
    // isn't one. See the trade-off note at the top of redaction.ts.
    for (const fact of [
        "My account id is 0x7f3a9c2e5b8d1f4a6c9e2b5d8f1a4c7e0b3d6f9a2c5e8b1d4f7a0c3e6b9d2f5a",
        "The blob landed as blob_id=Xj9vKq2mP7nR4tW8yB1cE5gH0dF3sA6uZ2xN8qL4kM7",
        "Pin the build to commit 4f2b8c1e9d7a3f5b6c0e2d4a8b1f3c5e7d9a0b2c",
        "The sha256 of the release tarball is e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "My Sui package id is 0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437",
    ]) {
        const out = sanitizeFact(fact);
        assert.equal(out.text, fact, `redacted a legitimate identifier: ${fact}`);
        assert.equal(out.changed, false);
    }
});

// ── refusals ────────────────────────────────────────────────────────────────

test("an explicit do-not-save is honoured", () => {
    for (const text of [
        "My bank PIN is 4821 — don't save this.",
        "Do not remember this: I'm interviewing elsewhere.",
        "Off the record, I'm leaving the team in March.",
        "Please don't store that anywhere.",
    ]) {
        const out = sanitizeFact(text);
        assert.equal(out.refusal, "no-save-directive", `not refused: ${text}`);
        assert.equal(out.text, "");
    }
});

test("an ordinary preference about not saving things is NOT a do-not-save", () => {
    // The demonstrative ("this"/"that"/"it") is what separates the two, and
    // without it the directive check would eat real preferences.
    for (const text of [
        "I don't save screenshots to the Desktop, they go to ~/Pictures.",
        "Never store build artifacts in the repo — use the cache.",
        "Don't keep logs longer than 30 days on staging.",
    ]) {
        const out = sanitizeFact(text);
        assert.equal(out.refusal, undefined, `wrongly refused: ${text}`);
        assert.equal(out.text, text);
    }
});

test("pasted third-party content is not saved as a fact about the user", () => {
    const fenced = "```\nERROR 500 from vendor api\n  at handler (index.js:42)\n```";
    assert.equal(sanitizeFact(fenced).refusal, "pasted-content");

    const quotedBlock = "> their PM said the deadline slips\n> and the scope is unchanged";
    assert.equal(sanitizeFact(quotedBlock).refusal, "pasted-content");

    const longQuote = `"${"the vendor's release note says the same thing again and again. ".repeat(5)}"`;
    assert.ok(longQuote.length >= 200);
    assert.equal(sanitizeFact(longQuote).refusal, "pasted-content");
});

test("a short quoted fact is still saved — an agent quotes the user routinely", () => {
    const quoted = '"I always use pnpm"';
    const out = sanitizeFact(quoted);
    assert.equal(out.refusal, undefined);
    assert.equal(out.text, quoted);
});

test("a text that is nothing but a secret is refused, not stored as a placeholder", () => {
    const out = sanitizeFact("sk-abcdefghijklmnopqrstuvwxyz0123");
    assert.equal(out.refusal, "credential-only");
    assert.equal(out.text, "");
    assert.ok(out.kinds.includes("vendor-api-key"));
});

// ── what the caller is told ─────────────────────────────────────────────────

test("the notices name the kind and never the value", () => {
    const secret = "hunter2";
    const out = sanitizeFact(`db is postgres://admin:${secret}@db.internal/app for staging`);
    const notice = redactionNotice(out.kinds, out.count);
    assert.match(notice, /url-credentials/);
    assert.match(notice, /do not re-send/i);
    assert.ok(!notice.includes(secret), "the notice must not echo the secret");

    const refusal = refusalNotice("credential-only");
    assert.match(refusal, /NOT SAVED/);
    assert.match(refusal, /Do not retry this text/);
});

test("nothing removed means nothing said", () => {
    assert.equal(redactionNotice([], 0), "");
});
