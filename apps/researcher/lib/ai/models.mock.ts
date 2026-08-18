import type { LanguageModel } from "ai";

const mockResponses: Record<string, string> = {
  default: "This is a mock response for testing.",
  weather: "The weather in San Francisco is sunny and 72°F.",
  greeting: "Hello! How can I help you today?",
};

const mockUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function getResponseForPrompt(prompt: unknown): string {
  const promptStr = JSON.stringify(prompt).toLowerCase();

  if (promptStr.includes("weather") || promptStr.includes("temperature")) {
    return mockResponses.weather;
  }
  if (
    promptStr.includes("hello") ||
    promptStr.includes("hi") ||
    promptStr.includes("hey")
  ) {
    return mockResponses.greeting;
  }

  return mockResponses.default;
}

const createMockModel = (): LanguageModel => {
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-model",
    defaultObjectGenerationMode: "tool",
    supportedUrls: {},
    doGenerate: async ({ prompt }: { prompt: unknown }) => ({
      finishReason: "stop",
      usage: mockUsage,
      content: [{ type: "text", text: getResponseForPrompt(prompt) }],
      warnings: [],
    }),
    doStream: ({ prompt }: { prompt: unknown }) => {
      const response = getResponseForPrompt(prompt);
      const words = response.split(" ");

      return {
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "text-start", id: "t1" });
            for (const word of words) {
              controller.enqueue({
                type: "text-delta",
                id: "t1",
                delta: `${word} `,
              });
              await new Promise((resolve) => {
                setTimeout(resolve, 10);
              });
            }
            controller.enqueue({ type: "text-end", id: "t1" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: mockUsage,
            });
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
};

const createMockReasoningModel = (): LanguageModel => {
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-reasoning-model",
    defaultObjectGenerationMode: "tool",
    supportedUrls: {},
    doGenerate: async () => ({
      finishReason: "stop",
      usage: mockUsage,
      content: [{ type: "text", text: "This is a reasoned response." }],
      reasoning: [
        { type: "text", text: "Let me think through this step by step..." },
      ],
      warnings: [],
    }),
    doStream: () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "reasoning-start", id: "r1" });
          controller.enqueue({
            type: "reasoning-delta",
            id: "r1",
            delta: "Let me think through this step by step... ",
          });
          controller.enqueue({ type: "reasoning-end", id: "r1" });
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({
            type: "text-delta",
            id: "t1",
            delta: "This is a reasoned response.",
          });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: mockUsage,
          });
          controller.close();
        },
      }),
    }),
  } as unknown as LanguageModel;
};

/**
 * When a user message contains this sentinel, the mock title model rejects.
 * The e2e suite uses it to reproduce the retired-title-model production
 * failure and assert the chat stream still completes without an error part
 * (the try/catch guard in app/(chat)/api/chat/route.ts).
 * Mirrored in tests/playwright/helpers.ts — keep the two in sync.
 */
export const TITLE_FAILURE_SENTINEL = "FAIL_TITLE_GENERATION";

function assertTitlePromptOk(prompt: unknown): void {
  if (JSON.stringify(prompt).includes(TITLE_FAILURE_SENTINEL)) {
    throw new Error("Mock title model failure (TITLE_FAILURE_SENTINEL)");
  }
}

const createMockTitleModel = (): LanguageModel => {
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-title-model",
    defaultObjectGenerationMode: "tool",
    supportedUrls: {},
    doGenerate: async ({ prompt }: { prompt: unknown }) => {
      assertTitlePromptOk(prompt);
      return {
        finishReason: "stop",
        usage: {
          inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        content: [{ type: "text", text: "Test Conversation" }],
        warnings: [],
      };
    },
    doStream: ({ prompt }: { prompt: unknown }) => ({
      stream: new ReadableStream({
        start(controller) {
          assertTitlePromptOk(prompt);
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({
            type: "text-delta",
            id: "t1",
            delta: "Test Conversation",
          });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: {
                total: 5,
                noCache: 5,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  } as unknown as LanguageModel;
};

export const chatModel = createMockModel();
export const reasoningModel = createMockReasoningModel();
export const titleModel = createMockTitleModel();
