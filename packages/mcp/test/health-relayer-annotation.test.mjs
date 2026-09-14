import assert from "node:assert/strict";
import test from "node:test";

import { annotateHealthResult } from "../dist/bridge.js";

// The relayer can only name an origin its deployment published, and says
// nothing on a self-hosted or local one — the sidecar there knows only the
// loopback address it dials. The bridge always knows the URL it connected to,
// which is exactly what `--prod` / `--relayer` / MEMWAL_SERVER_URL selected.

const DEV = "https://relayer.dev.memwal.ai";

const healthResult = (text) => ({ content: [{ type: "text", text }] });

test("names the dialled relayer when the reply carries none", () => {
    const result = healthResult("Walrus Memory is reachable. status=ok version=1.2.3");
    annotateHealthResult(result, DEV);
    assert.ok(result.content[0].text.includes(`relayer=${DEV}`));
    // Existing fields must survive.
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
    // The field after it must not be eaten by the replacement.
    assert.ok(text.includes("write_ready=true"));
});

test("leaves a failed health call alone", () => {
    // Naming a relayer beside an error reads as though that relayer answered.
    const result = { ...healthResult("relayer unreachable"), isError: true };
    annotateHealthResult(result, DEV);
    assert.equal(result.content[0].text, "relayer unreachable");
});

test("tolerates a result shape it does not recognise", () => {
    for (const result of [{}, { content: [] }, { content: "nope" }, { content: [{ type: "image" }] }]) {
        assert.doesNotThrow(() => annotateHealthResult(result, DEV));
    }
});
