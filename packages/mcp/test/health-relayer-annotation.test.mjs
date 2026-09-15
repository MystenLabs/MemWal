import assert from "node:assert/strict";
import test from "node:test";

import { annotateHealthResult } from "../dist/format.js";

const DEV = "https://relayer.dev.memwal.ai";

const healthResult = (text) => ({ content: [{ type: "text", text }] });

test("names the dialled relayer when the reply carries none", () => {
    const result = healthResult("Walrus Memory is reachable. status=ok version=1.2.3");
    annotateHealthResult(result, DEV);
    assert.ok(result.content[0].text.includes(`relayer=${DEV}`));
    assert.ok(result.content[0].text.includes("status=ok"));
    assert.ok(result.content[0].text.includes("version=1.2.3"));
});

test("replaces the relayer the reply already carried rather than adding a second", () => {
    const result = healthResult(
        "Walrus Memory is reachable. status=ok version=1.2.3 relayer=https://stale.example write_ready=true",
    );
    annotateHealthResult(result, DEV);
    const text = result.content[0].text;
    assert.equal(text.match(/relayer=/g).length, 1, `two relayer fields:\n${text}`);
    assert.ok(text.includes(`relayer=${DEV}`));
    assert.ok(!text.includes("stale.example"));
    assert.ok(text.includes("write_ready=true"));
});

test("leaves a failed health call alone", () => {
    const result = { ...healthResult("relayer unreachable"), isError: true };
    annotateHealthResult(result, DEV);
    assert.equal(result.content[0].text, "relayer unreachable");
});

test("tolerates a result shape it does not recognise", () => {
    for (const result of [{}, { content: [] }, { content: "nope" }, { content: [{ type: "image" }] }]) {
        assert.doesNotThrow(() => annotateHealthResult(result, DEV));
    }
});
