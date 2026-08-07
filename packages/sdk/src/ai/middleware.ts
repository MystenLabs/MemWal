/**
 * Walrus Memory AI SDK Integration — withMemWal Middleware
 *
 * Wraps any AI SDK model with automatic memory management.
 *
 * @example
 * ```typescript
 * import { generateText } from "ai"
 * import { withMemWal } from "@mysten-incubation/memwal/ai"
 * import { openai } from "@ai-sdk/openai"
 *
 * const model = withMemWal(openai("gpt-4o"), {
 *   key: process.env.MEMWAL_PRIVATE_KEY,  // Ed25519 delegate private key (hex)
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
import {
    formatUntrustedMemories,
    UNTRUSTED_MEMORY_SYSTEM_INSTRUCTION,
} from "./untrusted-memory.js";

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
 * Wrap an AI SDK model with Walrus Memory management
 *
 * BEFORE each LLM call:
 * - Uses the last user message as a search query
 * - Recalls relevant memories (server: search → download → decrypt)
 * - Injects relevant memories as nonce-delimited, untrusted user data
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
        ? (...args: unknown[]) => console.warn("[Walrus Memory]", ...args)
        : () => { };

    // Fire-and-forget auto-save writes are tracked here so short-lived
    // callers (CLI scripts, serverless handlers) can await them via
    // flush() before the process exits, instead of losing them silently.
    const pendingSaves = new Set<Promise<unknown>>();

    function saveInBackground(userMessage: string): void {
        const savePromise = memwal
            .analyze(userMessage)
            .catch((err: unknown) => log("Auto-save failed:", err));
        pendingSaves.add(savePromise);
        savePromise.finally(() => pendingSaves.delete(savePromise));
    }

    const wrapped = (wrapLanguageModel as any)({
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

                    const memoryContext = formatUntrustedMemories(relevant);
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
                        saveInBackground(userMessage);
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
                        saveInBackground(userMessage);
                    }
                }

                return result;
            },
        },
    });

    // Lets short-lived callers await outstanding auto-save writes before
    // exiting, e.g. `await model.flush()` right before `process.exit()`.
    wrapped.flush = async (): Promise<void> => {
        await Promise.allSettled([...pendingSaves]);
    };

    return wrapped;
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

export function injectMemoryContext(
    prompt: unknown,
    memoryContext: string
): unknown {
    if (!Array.isArray(prompt)) return prompt;

    // Keep the fixed trust policy in a system message, but recalled bytes only
    // in a separate user message. No memory-controlled text receives system
    // priority.
    const lastUserIndex = prompt.reduce(
        (idx: number, m: any, i: number) => (m.role === "user" ? i : idx),
        -1
    );

    if (lastUserIndex > 0) {
        const result = [...prompt];
        result.splice(
            lastUserIndex,
            0,
            {
                role: "system" as const,
                content: UNTRUSTED_MEMORY_SYSTEM_INSTRUCTION,
            },
            {
                role: "user" as const,
                content: [{ type: "text" as const, text: memoryContext }],
            }
        );
        return result;
    }

    return [
        {
            role: "system" as const,
            content: UNTRUSTED_MEMORY_SYSTEM_INSTRUCTION,
        },
        {
            role: "user" as const,
            content: [{ type: "text" as const, text: memoryContext }],
        },
        ...prompt,
    ];
}
