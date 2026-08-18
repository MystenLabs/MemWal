import { createOpenAI } from "@ai-sdk/openai";
import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { isTestEnvironment } from "../constants";
import { TITLE_MODEL } from "./models";

const THINKING_SUFFIX_REGEX = /-thinking$/;

// OpenRouter provider (OpenAI-compatible)
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY || "",
});

export const myProvider = isTestEnvironment
  ? (() => {
    const {
      chatModel,
      reasoningModel,
      titleModel,
    } = require("./models.mock");
    return customProvider({
      languageModels: {
        "chat-model": chatModel,
        "chat-model-reasoning": reasoningModel,
        "title-model": titleModel,
      },
    });
  })()
  : null;

function isReasoningModelId(modelId: string) {
  return (
    modelId.endsWith("-thinking") ||
    (modelId.includes("reasoning") && !modelId.includes("non-reasoning"))
  );
}

const MOCK_MODEL_IDS = new Set([
  "chat-model",
  "chat-model-reasoning",
  "title-model",
]);

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    // The picker sends real OpenRouter ids; the mock provider only registers
    // its own three, so anything else must map onto them or languageModel()
    // throws NoSuchModelError on the first test message.
    if (MOCK_MODEL_IDS.has(modelId)) {
      return myProvider.languageModel(modelId);
    }
    return myProvider.languageModel(
      isReasoningModelId(modelId) ? "chat-model-reasoning" : "chat-model"
    );
  }

  const isReasoningModel = isReasoningModelId(modelId);

  if (isReasoningModel) {
    const gatewayModelId = modelId.replace(THINKING_SUFFIX_REGEX, "");

    return wrapLanguageModel({
      model: openrouter.chat(gatewayModelId),
      middleware: extractReasoningMiddleware({ tagName: "thinking" }),
    });
  }

  return openrouter.chat(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return openrouter.chat(TITLE_MODEL);
}

/** OpenRouter embedding model for source chunk embeddings */
export function getEmbeddingModel() {
  return openrouter.embedding("openai/text-embedding-3-small");
}
