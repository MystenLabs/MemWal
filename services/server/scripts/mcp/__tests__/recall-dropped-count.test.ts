/**
 * `memwal_recall` must report the matches it could not return.
 *
 * The relayer omits from `results` any match whose blob failed to download or
 * whose ciphertext failed to decrypt, and counts them in `dropped_count`. Left
 * unreported, that loss reaches the model as absence: ten stored memories that
 * all fail to decrypt look exactly like an empty namespace, and seven returned
 * out of ten look exactly like a complete answer. Both are wrong answers the
 * model would act on (WALM-397).
 *
 * These tests pin the two halves of the reporting — the empty case in
 * `emptyRecallText`, the partial case in `recallNotices` — and guard the
 * lossless path from picking up noise.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { MemWalSession } from "../auth.js";
import { createMcpServer } from "../server.js";
import { emptyRecallText, formatRecallLine, recallNotices } from "../tools/recall.js";

const row = (text: string, distance = 0.5) => ({ text, distance });

test("a partial loss is reported alongside the rows that survived", () => {
    const [notice, ...rest] = recallNotices(0, 3);
    assert.equal(rest.length, 0);
    assert.match(notice, /3 additional matches/);
    assert.match(notice, /omitted/);
});

test("the dropped notice names both causes, not decryption alone", () => {
    // The relayer counts download failures, permanent decrypt failures and
    // invalid UTF-8 into one dropped_count, so the notice must not pin the
    // loss on decryption. The two have different remedies — a failed Walrus
    // fetch is usually transient, an undecryptable blob is not — and a model
    // told "could not be decrypted" would send the user to re-authenticate
    // for what may be a retryable download.
    const [notice] = recallNotices(0, 2);
    assert.match(notice, /failed to download or decrypt/);
});

test("a lossless recall appends nothing", () => {
    // The common case must stay byte-identical: a trailing caveat on every
    // successful recall is noise the model pays for on every call.
    assert.deepEqual(recallNotices(0, 0), []);
});

test("a single dropped match reads as singular", () => {
    const [notice] = recallNotices(0, 1);
    assert.match(notice, /1 additional match /);
    assert.match(notice, /was omitted/);
    assert.doesNotMatch(notice, /matches/);
});

test("collapsed duplicates and dropped matches are reported separately", () => {
    // Folding away a fact stored twice and losing a fact to a failed decrypt
    // are different events. Conflating them would let real loss hide behind
    // the benign one.
    const [duplicates, dropped] = recallNotices(2, 3);
    assert.match(duplicates, /2 duplicate copies/);
    assert.doesNotMatch(duplicates, /decrypt/);
    assert.match(dropped, /3 additional matches/);
    assert.doesNotMatch(dropped, /duplicate/);
});

test("the rendered payload keeps every returned row and still flags the loss", () => {
    // Mirrors what the tool builds: numbered hits, then the notices.
    const unique = [row("deploy region is ap-southeast-1", 0.1), row("uses pnpm, not npm", 0.2)];
    const lines = unique.map((m, i) => formatRecallLine(m, i));
    lines.push(...recallNotices(0, 2));
    const text = lines.join("\n");

    assert.match(text, /deploy region is ap-southeast-1/);
    assert.match(text, /uses pnpm, not npm/);
    assert.match(text, /2 additional matches/);
});

test("an all-dropped recall is not reported as an empty namespace", () => {
    // The headline bug: every match failed to decrypt, so results is empty and
    // the model must not be told there is nothing stored.
    const text = emptyRecallText(0, 3);
    assert.notEqual(text, "No matching memories found.");
    assert.match(text, /3 matched/);
    assert.match(text, /not an empty namespace/i);
});

test("a genuinely empty namespace keeps the documented wording", () => {
    // Quoted verbatim as a troubleshooting heading in docs/mcp/reference.md.
    assert.equal(emptyRecallText(0, 0), "No matching memories found.");
});

/**
 * The helper tests above pin the wording. This one pins the wiring: that the
 * tool actually calls it. Without it the whole notice can be deleted from the
 * handler and every other test in this file still passes, which is exactly the
 * regression WALM-397 describes.
 */
async function recallText(
    result: unknown,
    args: Record<string, unknown> = { query: "q", limit: 10 },
): Promise<string> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
        oauthScope: "memwal:read",
        memwal: { recall: async () => result },
    } as unknown as MemWalSession);
    const client = new Client({ name: "dropped-count-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        const res = (await client.callTool({
            name: "memwal_recall",
            arguments: args,
        })) as { content: Array<{ text: string }> };
        return res.content.map((c) => c.text).join("\n");
    } finally {
        await client.close();
        await server.close();
    }
}

test("memwal_recall itself appends the dropped notice to a partial result", async () => {
    const text = await recallText({
        results: [row("deploy region is ap-southeast-1", 0.1)],
        dropped_count: 2,
    });
    assert.match(text, /deploy region is ap-southeast-1/);
    assert.match(text, /2 additional matches failed to download or decrypt/);
});

test("memwal_recall stays silent when the relayer omits dropped_count", async () => {
    const text = await recallText({ results: [row("uses pnpm, not npm", 0.2)] });
    assert.match(text, /uses pnpm, not npm/);
    assert.doesNotMatch(text, /omitted/);
});
