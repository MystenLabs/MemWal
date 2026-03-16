/**
 * MemWal AI SDK Integration — withMemWal Middleware
 *
 * Wraps any AI SDK model with automatic memory management.
 *
 * @example
 * ```typescript
 * import { generateText } from "ai"
 * import { withMemWal } from "@cmdoss/memwal/ai"
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

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { MemWal } from "../memwal.js";
import type { MemWalConfig, RecallMemory } from "../types.js";

// ============================================================
// Config
// ============================================================

/**
 * Accept both LanguageModelV2 (ai SDK v4/v5) and LanguageModelV3 (ai SDK v6+).
 * We use `any` because LanguageModelV3 may not exist in older @ai-sdk/provider,
 * and the two interfaces are structurally incompatible at the type level.
 * `wrapLanguageModel` from `ai` handles version detection internally.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLanguageModel = any;

export interface WithMemWalOptions extends MemWalConfig {
    /** Max memories to inject per request (default: 5) */
    maxMemories?: number;
    /** Auto-save new facts from conversation (default: true) */
    autoSave?: boolean;
    /** Minimum similarity score to include a memory (0-1, default: 0.3) */
    minRelevance?: number;
    /** Enable debug logging (default: false) */
    debug?: boolean;
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
    model: AnyLanguageModel,
    options: WithMemWalOptions
) {
    const memwal = MemWal.create(options);
    const maxMemories = options.maxMemories ?? 5;
    const autoSave = options.autoSave ?? true;
    const minRelevance = options.minRelevance ?? 0.3;
    const debug = options.debug ?? false;

    const log = debug
        ? (...args: unknown[]) => console.warn("[MemWal]", ...args)
        : () => { };

    return (wrapLanguageModel as any)({
        model,
        middleware: {
            specificationVersion: 'v3', // Required by ai SDK v6+; ignored by v4/v5
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

                    log(`🔍 Found ${relevant.length} relevant memories`);

                    return { ...params, prompt: enrichedPrompt };
                } catch (error) {
                    log("Memory search failed:", error);
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
                        memwal.analyze(userMessage).catch((err: unknown) =>
                            log("Auto-save failed:", err)
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
                        memwal.analyze(userMessage).catch((err: unknown) =>
                            log("Auto-save failed:", err)
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
    prompt: unknown
): string | null {
    if (!Array.isArray(prompt)) return null;

    for (let i = prompt.length - 1; i >= 0; i--) {
        const msg = prompt[i] as { role?: string; content?: unknown };
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
    prompt: unknown,
    memoryContext: string
): unknown {
    if (!Array.isArray(prompt)) return prompt;

    // Insert memory as a separate system message right before the last user message
    // This ensures the LLM sees it prominently, not buried in a long system prompt
    const lastUserIndex = prompt.reduce(
        (idx: number, m: any, i: number) => (m.role === "user" ? i : idx),
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
