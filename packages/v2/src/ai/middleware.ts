/**
 * MemWal AI SDK Integration — withMemWal Middleware
 *
 * Wraps any AI SDK model with automatic memory management.
 *
 * @example
 * ```typescript
 * import { generateText } from "ai"
 * import { withMemWal } from "@cmdoss/memwal-v2/ai"
 * import { openai } from "@ai-sdk/openai"
 *
 * const model = withMemWal(openai("gpt-4o"), {
 *   key: process.env.MEMWAL_KEY,  // Ed25519 delegate key (hex)
 * })
 *
 * const result = await generateText({
 *   model,
 *   messages: [{ role: "user", content: "What do you know about me?" }]
 * })
 * // → Automatically searches memories, injects context, saves new facts
 * ```
 */

import { wrapLanguageModel } from "ai";
import { MemWal } from "../memwal.js";
import type { MemWalConfig, RecallMemory } from "../types.js";

// ============================================================
// Config
// ============================================================

export interface WithMemWalOptions extends MemWalConfig {
    /** Max memories to inject per request (default: 5) */
    maxMemories?: number;
    /** Auto-save new facts from conversation (default: true) */
    autoSave?: boolean;
    /** Minimum similarity score to include a memory (0-1, default: 0.3) */
    minRelevance?: number;
}

// ============================================================
// Middleware
// ============================================================

/**
 * Wrap an AI SDK model with MemWal memory management
 *
 * BEFORE each LLM call:
 * - Uses the last user message as a search query
 * - Recalls relevant memories (server: search → download → decrypt)
 * - Injects relevant memories into the system prompt
 *
 * AFTER each LLM call:
 * - Analyzes and saves important facts (server: LLM extract → embed → encrypt → Walrus → store)
 * - Fire-and-forget — does not block the response
 */
export function withMemWal(
    model: any,
    options: WithMemWalOptions
): any {
    const memwal = MemWal.create(options);
    const maxMemories = options.maxMemories ?? 5;
    const autoSave = options.autoSave ?? true;
    const minRelevance = options.minRelevance ?? 0.3;

    return wrapLanguageModel({
        model,
        middleware: {
            // ============================================================
            // BEFORE: Search memories + inject into prompt
            // ============================================================
            transformParams: async ({ params }: any) => {
                try {
                    const lastUserMessage = findLastUserMessage(params.prompt);
                    if (!lastUserMessage) return params;

                    const recallResult = await memwal.recall(lastUserMessage, maxMemories);

                    // Filter by minimum relevance (distance < 1 - minRelevance)
                    const relevant = recallResult.results.filter(
                        (m: RecallMemory) => (1 - m.distance) >= minRelevance
                    );

                    if (relevant.length === 0) return params;

                    const memoryContext = formatMemories(relevant);
                    const enrichedPrompt = injectMemoryContext(
                        params.prompt,
                        memoryContext
                    );

                    console.log(
                        `[MemWal] 🔍 Found ${relevant.length} relevant memories`
                    );

                    return { ...params, prompt: enrichedPrompt };
                } catch (error) {
                    console.warn("[MemWal] Memory search failed:", error);
                    return params;
                }
            },

            // ============================================================
            // AFTER: Analyze and save important facts (fire-and-forget)
            // ============================================================
            wrapGenerate: async ({ doGenerate, params }: any) => {
                const result = await doGenerate();

                if (autoSave) {
                    const userMessage = findLastUserMessage(params.prompt);
                    if (userMessage) {
                        memwal.analyze(userMessage).catch((err: any) =>
                            console.warn("[MemWal] Auto-save failed:", err)
                        );
                    }
                }

                return result;
            },

            // Stream variant — needed for streamText()
            wrapStream: async ({ doStream, params }: any) => {
                const result = await doStream();

                if (autoSave) {
                    const userMessage = findLastUserMessage(params.prompt);
                    if (userMessage) {
                        memwal.analyze(userMessage).catch((err: any) =>
                            console.warn("[MemWal] Auto-save failed:", err)
                        );
                    }
                }

                return result;
            },
        },
    });
}

// ============================================================
// Helpers
// ============================================================

function findLastUserMessage(
    prompt: any
): string | null {
    if (!Array.isArray(prompt)) return null;

    for (let i = prompt.length - 1; i >= 0; i--) {
        const msg = prompt[i] as any;
        if (msg.role === "user") {
            if (typeof msg.content === "string") return msg.content;
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter((p: any) => p.type === "text")
                    .map((p: any) => p.text);
                return textParts.join(" ") || null;
            }
        }
    }
    return null;
}

function formatMemories(memories: RecallMemory[]): string {
    const lines = memories.map(
        (m) => `- ${m.text} (relevance: ${(1 - m.distance).toFixed(2)})`
    );
    return `[Memory Context] The following are known facts about this user from their personal memory store. Use these facts to answer the user's question:\n${lines.join("\n")}`;
}

function injectMemoryContext(
    prompt: any,
    memoryContext: string
): any {
    if (!Array.isArray(prompt)) return prompt;

    // Insert memory as a separate system message right before the last user message
    // This ensures the LLM sees it prominently, not buried in a long system prompt
    const lastUserIndex = prompt.reduce(
        (idx, m, i) => ((m as any).role === "user" ? i : idx),
        -1
    );

    if (lastUserIndex > 0) {
        const result = [...prompt];
        result.splice(lastUserIndex, 0, {
            role: "system" as const,
            content: memoryContext,
        });
        return result;
    }

    // Fallback: prepend as system message
    return [{ role: "system" as const, content: memoryContext }, ...prompt];
}
