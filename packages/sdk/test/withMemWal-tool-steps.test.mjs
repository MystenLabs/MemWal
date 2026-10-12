import assert from "node:assert/strict";
import test from "node:test";

import { MemWal } from "../dist/memwal.js";
import { withMemWal } from "../dist/ai/middleware.js";

const TEST_KEY = "11".repeat(32);
const TEST_ACCOUNT_ID = "0x1";

const generatedPrompts = [];

function fakeLanguageModel() {
    return {
        specificationVersion: "v2",
        provider: "test",
        modelId: "test-model",
        supportedUrls: {},
        doGenerate: async (options) => {
            generatedPrompts.push(options?.prompt);
            return {
                content: [{ type: "text", text: "hi" }],
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                warnings: [],
            };
        },
        doStream: async () => ({ stream: new ReadableStream() }),
    };
}
test("withMemWal does not re-recall or re-analyze during multi-step tool calls", async () => {
    const originalRecall = MemWal.prototype.recall;
    const originalAnalyze = MemWal.prototype.analyze;

    let recallCount = 0;
    let analyzeCount = 0;

    MemWal.prototype.recall = async () => {
        recallCount++;
        return {
            results: [{ text: "Tokyo is in Japan", distance: 0.1 }],
            total: 1,
        };
    };
    MemWal.prototype.analyze = async () => {
        analyzeCount++;
    };

    try {
        generatedPrompts.length = 0;
        const model = withMemWal(fakeLanguageModel(), {
            key: TEST_KEY,
            accountId: TEST_ACCOUNT_ID,
            autoSave: true,
        });

        // Step 1: User turn starts (prompt ends with user message)
        const step1Prompt = [
            { role: "user", content: [{ type: "text", text: "What is the weather in Tokyo?" }] },
        ];
        await model.doGenerate({ prompt: step1Prompt });
        await model.flush();

        assert.equal(recallCount, 1, "recall should be called once on user turn start");
        assert.equal(analyzeCount, 1, "analyze should be called once on user turn start");

        // Step 2: Tool execution continuation (prompt ends with tool message)
        const step2Prompt = [
            ...step1Prompt,
            {
                role: "assistant",
                content: [{ type: "tool-call", toolName: "getWeather", args: { city: "Tokyo" } }],
            },
            {
                role: "tool",
                content: [{ type: "tool-result", toolName: "getWeather", result: "22C" }],
            },
        ];

        const step2 = await model.doGenerate({ prompt: step2Prompt });
        await model.flush();

        assert.equal(recallCount, 1, "recall must NOT be called again during intermediate tool step");
        assert.equal(analyzeCount, 1, "analyze must NOT be called again during intermediate tool step");
        assert.equal(step2.finishReason, "stop");
        assert.match(
            JSON.stringify(generatedPrompts.at(-1)),
            /Tokyo is in Japan/,
            "the answer step must still contain the cached memory",
        );

        // Step 3: Next user turn starts (prompt ends with new user message)
        const step3Prompt = [
            ...step2Prompt,
            { role: "assistant", content: [{ type: "text", text: "It is 22C in Tokyo." }] },
            { role: "user", content: [{ type: "text", text: "What about Kyoto?" }] },
        ];

        await model.doGenerate({ prompt: step3Prompt });
        await model.flush();

        assert.equal(recallCount, 2, "recall should be called for the new user turn");
        assert.equal(analyzeCount, 2, "analyze should be called for the new user turn");
    } finally {
        MemWal.prototype.recall = originalRecall;
        MemWal.prototype.analyze = originalAnalyze;
    }
});

test("withMemWal stream variant does not re-analyze during tool steps", async () => {
    const originalRecall = MemWal.prototype.recall;
    const originalAnalyze = MemWal.prototype.analyze;

    let analyzeCount = 0;

    MemWal.prototype.recall = async () => ({ results: [], total: 0 });
    MemWal.prototype.analyze = async () => {
        analyzeCount++;
    };

    try {
        const model = withMemWal(fakeLanguageModel(), {
            key: TEST_KEY,
            accountId: TEST_ACCOUNT_ID,
            autoSave: true,
        });

        // Prompt ending with tool result
        const toolStepPrompt = [
            { role: "user", content: [{ type: "text", text: "Search for hotels" }] },
            { role: "assistant", content: [{ type: "tool-call", toolName: "searchHotels" }] },
            { role: "tool", content: [{ type: "tool-result", result: "Hotel A" }] },
        ];

        await model.doStream({ prompt: toolStepPrompt });
        await model.flush();

        assert.equal(analyzeCount, 0, "analyze must not run when stream prompt ends with tool result");
    } finally {
        MemWal.prototype.recall = originalRecall;
        MemWal.prototype.analyze = originalAnalyze;
    }
});
