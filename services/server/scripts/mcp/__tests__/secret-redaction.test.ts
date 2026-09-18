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

test("MemWal's own delegate private key is removed, in every shape it arrives in", () => {
    // The 64-hex Ed25519 seed from ~/.memwal/credentials.json. auth.ts marks it
    // "NEVER log this": whoever holds it can read and write the user's memories
    // until the delegate is revoked. It is pure lowercase hex, so the entropy
    // rule deliberately does not see it — the LABEL is what catches it.
    const SEED = "4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b";

    // A pasted line from the file, the file itself, prose, and the label after
    // the value. Each keeps a fact around it so the refusal path is not what is
    // being measured here.
    for (const text of [
        `Notes from setup: delegatePrivateKey ${SEED} was written on this laptop`,
        `Notes from setup: "delegatePrivateKey": "${SEED}" is in the file`,
        `Notes from setup: my delegate private key is ${SEED} on this laptop`,
        `Notes from setup: ${SEED} is my private key for this laptop`,
        `Notes from setup: secret_key = ${SEED} on this laptop`,
        `Notes from setup: the signing key 0x${SEED} lives on this laptop`,
    ]) {
        const out = sanitizeFact(text);
        assert.equal(out.refusal, undefined, `unexpectedly refused: ${text}`);
        assert.ok(!out.text.includes(SEED), `the delegate key survived: ${text}`);
        assert.ok(out.text.includes("Notes from setup"), `lost the fact: ${text}`);
    }
});

test("an UNLABELLED hex run is still left alone — that is what the label gate buys", () => {
    // The regression this design protects. Same 64 hex characters as the test
    // above; the only difference is that nothing calls them a key.
    const HEX = "4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b";
    for (const fact of [
        `The release digest is ${HEX} and I verified it`,
        `Pin the deployment to 0x${HEX}`,
        // "credentials.json" is a phrase MemWal prose uses constantly, and it
        // sits within a window of the SHA here. It is excluded from the label
        // list precisely so this sentence keeps its commit id.
        "My creds live in ~/.memwal/credentials.json and the fix landed in 4f2b8c1e9d7a3f5b6c0e2d4a8b1f3c5e7d9a0b2c",
        // Documented in auth.ts as "Safe to display" — the public half must not
        // be swept up with the private one.
        `My delegatePublicKeyHex is ${HEX}`,
    ]) {
        const out = sanitizeFact(fact);
        assert.equal(out.text, fact, `redacted an unlabelled hex run: ${fact}`);
        assert.equal(out.changed, false);
    }
});

test("a seed phrase is caught however the label is spelled", () => {
    const WORDS =
        "abandon ability able about above absent absorb abstract absurd abuse access accident";
    for (const text of [
        `Wallet notes: my recovery phrase is ${WORDS} for the mainnet wallet`,
        `Wallet notes: seed_phrase: ${WORDS} for the mainnet wallet`,
        `Wallet notes: "mnemonic": "${WORDS}" for the mainnet wallet`,
        `Wallet notes: seedPhrase=${WORDS} for the mainnet wallet`,
    ]) {
        const out = sanitizeFact(text);
        assert.equal(out.refusal, undefined, `unexpectedly refused: ${text}`);
        assert.ok(!out.text.includes(WORDS), `the mnemonic survived: ${text}`);
        assert.ok(out.text.includes("Wallet notes"), `lost the fact: ${text}`);
    }

    // Still true, and still documented: a bare word run with no label at all is
    // indistinguishable from a sentence, so it is left to the model rules.
    const bare = sanitizeFact(`I wrote down ${WORDS} yesterday`);
    assert.equal(bare.changed, false);
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
        "The migration artifact hashes to 9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
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

/* ───────────────────────────────────────────────────────────────────────────
 * Review findings on the WALM-642 branch. Each of these leaked, verbatim,
 * through `sanitizeFact` before the fix beside it.
 * ------------------------------------------------------------------------ */

// ── finding 3: the credential-assignment gate missed whole spellings ────────

test("SCREAMING_SNAKE and quoted-JSON credential names are assignments too", () => {
    // `_` is a word character, so `\b` never fired between `_` and the
    // keyword, and `_` is not `[a-z]` so the camelCase lookbehind did not
    // either. That left the spelling credentials actually arrive in — a pasted
    // env file or shell export — completely unguarded.
    for (const [text, secret] of [
        ["POSTGRES_PASSWORD=hunter2", "hunter2"],
        [
            "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        ],
        ["DB_PASSWORD=hunter2SuperSecret", "hunter2SuperSecret"],
        ["X_AUTH_TOKEN: abcd1234", "abcd1234"],
        ["SESSION_SECRET=abcd1234efgh5678", "abcd1234efgh5678"],
        ["my_api_key=abcd1234efgh5678", "abcd1234efgh5678"],
    ] as Array<[string, string]>) {
        const out = sanitizeFact(text);
        assert.ok(out.changed, `not redacted at all: ${text}`);
        assert.ok(!out.text.includes(secret), `the secret survived: ${text}`);
    }

    // A JSON object puts a closing quote between the key and the colon, which
    // the old separator group demanded come immediately after the keyword.
    const json = sanitizeFact(
        'Save my config: {"username": "alice", "password": "hunter2-prod-9xQ"} for staging',
    );
    assert.equal(json.refusal, undefined);
    assert.ok(!json.text.includes("hunter2-prod-9xQ"), "the JSON password survived");
    assert.ok(json.text.includes("alice"), "the username is not a credential");
    assert.ok(json.text.includes("for staging"), "the fact was lost with the password");
});

test("widening the gate did not widen it onto ordinary prose", () => {
    // The lookbehind now admits `_`, `-` and digits. These are the sentences
    // that must not start matching because of it.
    for (const fact of [
        "My password manager is 1Password and I rotate keys every quarter.",
        "The API key for that service is stored in Vault, not in the repo.",
        "My creds live in ~/.memwal/credentials.json and the fix landed in 4f2b8c1e9a7d6f5c4b3a29180716253443219876",
        "We renamed the secret_store module to vault_client last sprint.",
        "Token bucket rate limiting is what the relayer uses.",
    ]) {
        const out = sanitizeFact(fact);
        assert.equal(out.text, fact, `changed a clean fact: ${fact}`);
        assert.equal(out.changed, false);
    }
});

// ── finding 5: the label rule only ever looked at hex ───────────────────────

test("a labelled secret that is not hex is key material too", () => {
    // 40 characters, base64-ish, three label words in front of it — and it came
    // back completely unchanged, because `hasAdjacentCredentialLabel` was
    // consulted only for HEX_RUN and the entropy rule demands 64+.
    const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    assertRedacted(
        `My AWS secret access key is ${AWS_SECRET} for prod`,
        AWS_SECRET,
        "labelled-key-material",
        ["My AWS secret access key", "for prod"],
    );

    // The pair, which is the shape it arrives in: the non-secret id was being
    // redacted by the vendor rule while the secret half survived.
    const pair = sanitizeFact(
        `AWS creds for staging: AKIAIOSFODNN7EXAMPLE and the secret key is ${AWS_SECRET}`,
    );
    assert.ok(!pair.text.includes(AWS_SECRET), "the secret half of the pair survived");
    assert.ok(!pair.text.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("the label is still the only discriminator — bare runs pass", () => {
    // The whole design: widening the SHAPE the rule can see must not weaken the
    // gate in front of it, or every identifier this product exists to remember
    // starts disappearing.
    for (const fact of [
        "The blob landed as blob_id=Xj9vKq2mP7nR4tW8yB1cE5gH0dF3sA6uZ2xN8qL4kM7",
        "Pin the build to commit 4f2b8c1e9d7a3f5b6c0e2d4a8b1f3c5e7d9a0b2c",
        "My Sui package id is 0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437",
        "My delegatePublicKeyHex is 4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b and it is safe to share",
        "The build id is 20260918T0930Z-linux-arm64-release-candidate",
    ]) {
        const out = sanitizeFact(fact);
        assert.equal(out.text, fact, `redacted a legitimate identifier: ${fact}`);
        assert.equal(out.changed, false);
    }
});

// ── findings 6 + 7: the URL rule was quadratic, and mangled ordinary URLs ───

test("an ordinary URL with a query string is not userinfo", () => {
    // The password group excluded `/` and whitespace but not `?` or `=`, so
    // this matched with `app.example.com` as the user and `8443?owner=alice` as
    // the password: host and port destroyed, `corp.com` promoted to hostname,
    // and a notice claiming a credential had been removed when there was none.
    const fact =
        "Our dashboard is at https://app.example.com:8443?owner=alice@corp.com and we deploy Fridays";
    const out = sanitizeFact(fact);
    assert.equal(out.text, fact, "an ordinary URL was mangled");
    assert.equal(out.changed, false);
    assert.equal(out.count, 0, "a redaction was reported where none happened");

    // ...while a real connection string is untouched by the narrowing.
    const real = sanitizeFact("staging is postgres://admin:hunter2@db.internal:5432/app");
    assert.ok(!real.text.includes("hunter2"));
    assert.ok(real.text.includes("db.internal:5432/app"), "the host was lost");
});

test("a long passage is screened in linear time", () => {
    // `URL_USERINFO`'s scheme repeat was unbounded, so it was tried and
    // abandoned at every start offset: 30 KB took 317 ms, 60 KB 1254 ms and
    // 120 KB 4814 ms. `memwal_analyze` takes a whole transcript, the sidecar is
    // single-threaded and a tools/call times out at 60 s, so a long paste was a
    // stall for every other caller too.
    //
    // The budget is deliberately loose — this is a guard against a quadratic
    // pattern coming back, not a benchmark, and CI machines are noisy. The
    // shape is what matters: 4x the input must not be 16x the time.
    const worst = "a".repeat(120 * 1024);
    const started = Date.now();
    sanitizeFact(worst);
    const elapsed = Date.now() - started;
    assert.ok(
        elapsed < 1000,
        `120 KB took ${elapsed} ms — a redaction pattern has gone superlinear again`,
    );

    const small = "a".repeat(30 * 1024);
    const t0 = Date.now();
    sanitizeFact(small);
    const smallMs = Math.max(Date.now() - t0, 1);
    assert.ok(
        elapsed / smallMs < 12,
        `120 KB/30 KB ratio was ${(elapsed / smallMs).toFixed(1)}x — that is quadratic, not linear`,
    );
});
