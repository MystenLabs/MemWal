import { createOpenAI } from "@ai-sdk/openai";
import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { withMemWal } from "@cmdoss/memwal-v2/ai";
import { isTestEnvironment } from "../constants";

const THINKING_SUFFIX_REGEX = /-thinking$/;

// OpenRouter provider (OpenAI-compatible)
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY || "",
});

export const myProvider = isTestEnvironment
  ? (() => {
    const {
      artifactModel,
      chatModel,
      reasoningModel,
      titleModel,
    } = require("./models.mock");
    return customProvider({
      languageModels: {
        "chat-model": chatModel,
        "chat-model-reasoning": reasoningModel,
        "title-model": titleModel,
        "artifact-model": artifactModel,
      },
    });
  })()
  : null;

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  const isReasoningModel =
    modelId.endsWith("-thinking") ||
    (modelId.includes("reasoning") && !modelId.includes("non-reasoning"));

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
  return openrouter.chat("google/gemini-2.0-flash-001");
}

export function getArtifactModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("artifact-model");
  }
  return openrouter.chat("anthropic/claude-3.5-haiku");
}

/**
 * Wrap a language model with MemWal memory layer.
 * Requires MEMWAL_KEY env var. Falls back to base model if not configured.
 */
export function getMemWalModel(modelId: string, memwalKey?: string) {
  const baseModel = getLanguageModel(modelId);

  const key = memwalKey || process.env.MEMWAL_KEY;
  const memwalServerUrl = process.env.MEMWAL_SERVER_URL;

  if (!key) {
    console.warn("[MemWal] MEMWAL_KEY not set — memory layer disabled");
    return baseModel;
  }

  return withMemWal(baseModel, {
    key,
    serverUrl: memwalServerUrl || "http://localhost:3001",
    maxMemories: 5,
    autoSave: true,
    minRelevance: 0,
    debug: true,
  });
}

