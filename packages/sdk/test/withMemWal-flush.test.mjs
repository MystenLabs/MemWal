import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { withMemWal } from "../dist/ai/middleware.js";

const TEST_KEY = "11".repeat(32);
const TEST_ACCOUNT_ID = "0x1";

function fakeLanguageModel() {
    return {
        specificationVersion: "v2",
        provider: "test",
        modelId: "test-model",
        supportedUrls: {},
        doGenerate: async () => ({
            content: [{ type: "text", text: "hi" }],
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            warnings: [],
        }),
        doStream: async () => ({ stream: new ReadableStream() }),
    };
}

test("flush() awaits the fire-and-forget auto-save analyze() call", async () => {
    const originalRecall = MemWal.prototype.recall;
    const originalAnalyze = MemWal.prototype.analyze;

    let releaseAnalyze;
    const gate = new Promise((resolve) => {
        releaseAnalyze = resolve;
    });
    let analyzeCompleted = false;

    MemWal.prototype.recall = async () => ({ results: [] });
    MemWal.prototype.analyze = async () => {
        await gate;
        analyzeCompleted = true;
    };

    try {
        const model = withMemWal(fakeLanguageModel(), {
            key: TEST_KEY,
            accountId: TEST_ACCOUNT_ID,
        });

        await model.doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "remember this" }] }],
        });

        // Fire-and-forget: the response came back, but the gated analyze()
        // call has not completed yet.
        assert.equal(analyzeCompleted, false);

        releaseAnalyze();
        await model.flush();

        assert.equal(analyzeCompleted, true);
    } finally {
        MemWal.prototype.recall = originalRecall;
        MemWal.prototype.analyze = originalAnalyze;
    }
});
