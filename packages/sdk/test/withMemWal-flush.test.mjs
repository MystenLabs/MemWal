import assert from "node:assert/strict";
import test from "node:test";

import { generateText } from "ai";

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

test("a tool step does not recall or analyze the same user message again", async () => {
    const originalRecall = MemWal.prototype.recall;
    const originalAnalyze = MemWal.prototype.analyze;
    let recalls = 0;
    let analyzes = 0;
    MemWal.prototype.recall = async () => {
        recalls += 1;
        return { results: [] };
    };
    MemWal.prototype.analyze = async () => {
        analyzes += 1;
    };

    try {
        const model = withMemWal(fakeLanguageModel(), {
            key: TEST_KEY,
            accountId: TEST_ACCOUNT_ID,
        });
        const user = { role: "user", content: [{ type: "text", text: "remember this" }] };
        await model.doGenerate({ prompt: [user] });
        await model.flush();
        assert.equal(recalls, 1);
        assert.equal(analyzes, 1);

        await model.doGenerate({
            prompt: [
                user,
                { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: {} }] },
                {
                    role: "tool",
                    content: [{
                        type: "tool-result",
                        toolCallId: "c1",
                        toolName: "lookup",
                        output: { type: "text", value: "ok" },
                    }],
                },
            ],
        });
        await model.flush();
        assert.equal(recalls, 1);
        assert.equal(analyzes, 1);
    } finally {
        MemWal.prototype.recall = originalRecall;
        MemWal.prototype.analyze = originalAnalyze;
    }
});

test("a wrapped v2 model still reports its finish reason", async () => {
    const originalRecall = MemWal.prototype.recall;
    const originalAnalyze = MemWal.prototype.analyze;

    MemWal.prototype.recall = async () => ({ results: [] });
    MemWal.prototype.analyze = async () => { };

    try {
        const model = withMemWal(fakeLanguageModel(), {
            key: TEST_KEY,
            accountId: TEST_ACCOUNT_ID,
        });

        const result = await generateText({ model, prompt: "hi" });

        assert.equal(result.finishReason, "stop");
    } finally {
        MemWal.prototype.recall = originalRecall;
        MemWal.prototype.analyze = originalAnalyze;
    }
});
