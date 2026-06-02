import { describe, expect, test } from "bun:test";
import { findLastUserMessage, injectMemoryContext, formatMemories } from "./middleware.js";

// ── findLastUserMessage ──────────────────────────────────────────────

describe("findLastUserMessage", () => {
    test("returns null for non-array prompt", () => {
        expect(findLastUserMessage("not an array")).toBeNull();
        expect(findLastUserMessage(null)).toBeNull();
        expect(findLastUserMessage(undefined)).toBeNull();
    });

    test("returns string content from last user message", () => {
        const prompt = [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there!" },
            { role: "user", content: "What is my name?" },
        ];
        expect(findLastUserMessage(prompt)).toBe("What is my name?");
    });

    test("returns joined text parts from array content", () => {
        const prompt = [
            {
                role: "user",
                content: [
                    { type: "text", text: "Hello" },
                    { type: "text", text: "world" },
                ],
            },
        ];
        expect(findLastUserMessage(prompt)).toBe("Hello world");
    });

    test("returns null for empty array", () => {
        expect(findLastUserMessage([])).toBeNull();
    });

    test("returns null when no user messages exist", () => {
        const prompt = [
            { role: "system", content: "You are helpful." },
            { role: "assistant", content: "Hi!" },
        ];
        expect(findLastUserMessage(prompt)).toBeNull();
    });
});

// ── injectMemoryContext ──────────────────────────────────────────────

describe("injectMemoryContext", () => {
    const memoryContext = "[Memory Context] User likes blue.";

    test("returns prompt unchanged for non-array", () => {
        expect(injectMemoryContext("not an array", memoryContext)).toBe("not an array");
    });

    test("appends to existing system message (Anthropic-safe)", () => {
        const prompt = [
            { role: "system", content: "You are Miso." },
            { role: "user", content: "Hi" },
        ];
        const result = injectMemoryContext(prompt, memoryContext) as any[];

        // Should still be exactly 2 messages — no extra system message
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe("system");
        expect(result[0].content).toBe("You are Miso.\n\n[Memory Context] User likes blue.");
        expect(result[1].role).toBe("user");
    });

    test("does not mutate the original prompt array", () => {
        const prompt = [
            { role: "system", content: "Original." },
            { role: "user", content: "Hi" },
        ];
        injectMemoryContext(prompt, memoryContext);
        expect(prompt[0].content).toBe("Original.");
    });

    test("prepends system message when none exists", () => {
        const prompt = [
            { role: "user", content: "Hi" },
        ];
        const result = injectMemoryContext(prompt, memoryContext) as any[];

        expect(result).toHaveLength(2);
        expect(result[0].role).toBe("system");
        expect(result[0].content).toBe(memoryContext);
        expect(result[1].role).toBe("user");
    });

    test("handles system message with non-string content", () => {
        const prompt = [
            { role: "system", content: 123 },
            { role: "user", content: "Hi" },
        ];
        const result = injectMemoryContext(prompt, memoryContext) as any[];

        expect(result).toHaveLength(2);
        expect(result[0].content).toBe(memoryContext);
    });

    test("works with multi-turn conversation", () => {
        const prompt = [
            { role: "system", content: "System prompt." },
            { role: "user", content: "First message" },
            { role: "assistant", content: "Response" },
            { role: "user", content: "Second message" },
        ];
        const result = injectMemoryContext(prompt, memoryContext) as any[];

        // Should be exactly 4 messages — memory appended to system, not inserted as new
        expect(result).toHaveLength(4);
        expect(result[0].role).toBe("system");
        expect(result[0].content).toContain("System prompt.");
        expect(result[0].content).toContain(memoryContext);
        // No second system message
        const systemCount = result.filter((m: any) => m.role === "system").length;
        expect(systemCount).toBe(1);
    });
});

// ── formatMemories ───────────────────────────────────────────────────

describe("formatMemories", () => {
    test("formats memories with relevance scores", () => {
        const memories = [
            { text: "User likes blue", distance: 0.3 },
            { text: "User is an artist", distance: 0.5 },
        ];
        const result = formatMemories(memories as any);

        expect(result).toContain("User likes blue (relevance: 0.70)");
        expect(result).toContain("User is an artist (relevance: 0.50)");
        expect(result).toContain("[Memory Context]");
    });

    test("returns header with empty list", () => {
        const result = formatMemories([]);
        expect(result).toContain("[Memory Context]");
    });
});
