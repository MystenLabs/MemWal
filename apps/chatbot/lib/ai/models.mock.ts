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

const GREETING_REGEX = /\b(hello|hi|hey)\b/;

type ModelMessage = {
  role?: string;
  content?: unknown;
};

/**
 * Read the newest user turn only. Matching the serialised prompt as a whole
 * swept in the system prompt, whose prose contains "hi" inside ordinary words
 * like "this", so every request looked like a greeting and the branches below
 * could never be told apart from a test.
 */
function lastUserText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return "";
  }

  const userMessages = (prompt as ModelMessage[]).filter(
    (message) => message?.role === "user"
  );
  const latest = userMessages.at(-1);

  if (!latest) {
    return "";
  }
  if (typeof latest.content === "string") {
    return latest.content.toLowerCase();
  }
  if (!Array.isArray(latest.content)) {
    return "";
  }

  return latest.content
    .map((part: unknown) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : ""
    )
    .join(" ")
    .toLowerCase();
}

const DOCUMENT_PROMPT_REGEX = /\b(essay|create a document|write a document)\b/;
const CREATE_DOCUMENT_CALL_ID = "call_doc";
const CREATE_DOCUMENT_INPUT = JSON.stringify({
  title: "Test Artifact",
  kind: "text",
});

function promptAlreadyCalledTools(prompt: unknown): boolean {
  if (!Array.isArray(prompt)) {
    return false;
  }
  for (const message of prompt as ModelMessage[]) {
    if (message?.role === "tool") {
      return true;
    }
    if (!Array.isArray(message?.content)) {
      continue;
    }
    for (const part of message.content as Array<{ type?: string }>) {
      if (
        part?.type === "tool-call" ||
        part?.type === "tool-result" ||
        part?.type === "tool-createDocument"
      ) {
        return true;
      }
    }
  }
  return false;
}

function shouldCreateDocument(prompt: unknown): boolean {
  return (
    !promptAlreadyCalledTools(prompt) &&
    DOCUMENT_PROMPT_REGEX.test(lastUserText(prompt))
  );
}

function getResponseForPrompt(prompt: unknown): string {
  const text = lastUserText(prompt);

  if (text.includes("weather") || text.includes("temperature")) {
    return mockResponses.weather;
  }
  if (GREETING_REGEX.test(text)) {
    return mockResponses.greeting;
  }

  return mockResponses.default;
}

function enqueueCreateDocument(controller: ReadableStreamDefaultController) {
  controller.enqueue({
    type: "tool-input-start",
    id: CREATE_DOCUMENT_CALL_ID,
    toolName: "createDocument",
  });
  controller.enqueue({
    type: "tool-input-delta",
    id: CREATE_DOCUMENT_CALL_ID,
    delta: CREATE_DOCUMENT_INPUT,
  });
  controller.enqueue({
    type: "tool-input-end",
    id: CREATE_DOCUMENT_CALL_ID,
  });
  controller.enqueue({
    type: "tool-call",
    toolCallId: CREATE_DOCUMENT_CALL_ID,
    toolName: "createDocument",
    input: CREATE_DOCUMENT_INPUT,
  });
  controller.enqueue({
    type: "finish",
    finishReason: "tool-calls",
    usage: mockUsage,
  });
}

const createMockModel = (): LanguageModel => {
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-model",
    defaultObjectGenerationMode: "tool",
    supportedUrls: {},
    doGenerate: async ({ prompt }: { prompt: unknown }) => {
      if (shouldCreateDocument(prompt)) {
        return {
          finishReason: "tool-calls",
          usage: mockUsage,
          content: [
            {
              type: "tool-call",
              toolCallId: CREATE_DOCUMENT_CALL_ID,
              toolName: "createDocument",
              input: CREATE_DOCUMENT_INPUT,
            },
          ],
          warnings: [],
        };
      }
      return {
        finishReason: "stop",
        usage: mockUsage,
        content: [{ type: "text", text: getResponseForPrompt(prompt) }],
        warnings: [],
      };
    },
    doStream: ({ prompt }: { prompt: unknown }) => {
      if (shouldCreateDocument(prompt)) {
        return {
          stream: new ReadableStream({
            async start(controller) {
              await new Promise((resolve) => {
                setTimeout(resolve, 500);
              });
              enqueueCreateDocument(controller);
              controller.close();
            },
          }),
        };
      }

      const response = getResponseForPrompt(prompt);
      const words = response.split(" ");

      return {
        stream: new ReadableStream({
          async start(controller) {
            // Hold the pre-stream window so E2E can observe UI transitions
            // that only exist during "submitted" state. Mock-only.
            await new Promise((resolve) => {
              setTimeout(resolve, 500);
            });
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

const createMockTitleModel = (): LanguageModel => {
  return {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "mock-title-model",
    defaultObjectGenerationMode: "tool",
    supportedUrls: {},
    doGenerate: async () => ({
      finishReason: "stop",
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      content: [{ type: "text", text: "Test Conversation" }],
      warnings: [],
    }),
    doStream: () => ({
      stream: new ReadableStream({
        start(controller) {
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
export const artifactModel = createMockModel();
