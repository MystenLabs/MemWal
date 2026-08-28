// Curated list of models available on OpenRouter
export const DEFAULT_CHAT_MODEL = "openai/gpt-4o-mini";

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

export const chatModels: ChatModel[] = [
  // OpenAI
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    description: "Fast and cost-effective for simple tasks",
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    description: "Most capable OpenAI model",
  },
  // Anthropic
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    description: "Fast and affordable, great for everyday tasks",
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    description: "Best balance of speed and intelligence",
  },
  // Google
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    description: "Ultra fast and affordable",
  },
  // DeepSeek
  {
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek V3",
    provider: "deepseek",
    description: "Strong open-source model",
  },
  // Reasoning models. The -thinking suffix is ours, not OpenRouter's:
  // getLanguageModel strips it and wraps the base id (see providers.ts).
  {
    id: "anthropic/claude-sonnet-4.5-thinking",
    name: "Claude Sonnet 4.5 (Thinking)",
    provider: "reasoning",
    description: "Extended thinking for complex problems",
  },
];

/**
 * Models for the two background calls the picker never covers: chat titles and
 * artifact content.
 *
 * Declared beside the curated list rather than hardcoded at the call site. The
 * previous inline ids ("google/gemini-2.0-flash-001" for titles,
 * "anthropic/claude-3.5-haiku" for artifacts) were retired upstream and 404'd
 * on every request, and nothing tied them back to the models the app maintains.
 * Keep both pointing at an id present in `chatModels`.
 */
export const TITLE_MODEL = "google/gemini-2.5-flash";
export const ARTIFACT_MODEL = "anthropic/claude-haiku-4.5";

// An uncapped request is billed as if it will emit the model's whole output
// window, and OpenRouter reserves that much credit up front for Anthropic and
// Google models. Left unset, picking one of those rejects the turn outright
// ("requires more credits ... you requested up to 65535 tokens") however short
// the answer would have been.
export const MAX_OUTPUT_TOKENS = 4096;
// Has to clear the thinking budget the chat route asks for, or the answer is
// truncated before any of it reaches the reply.
export const MAX_REASONING_OUTPUT_TOKENS = 12_000;
export const MAX_TITLE_OUTPUT_TOKENS = 64;

const THINKING_SUFFIX_REGEX = /-thinking$/;

// "-thinking" is our own marker, not part of any OpenRouter id.
export function baseOpenRouterId(modelId: string): string {
  return modelId.replace(THINKING_SUFFIX_REGEX, "");
}

export function isReasoningModelId(modelId: string): boolean {
  return (
    THINKING_SUFFIX_REGEX.test(modelId) ||
    (modelId.includes("reasoning") && !modelId.includes("non-reasoning"))
  );
}

// Every id the app can send upstream. OpenRouter retires ids on its own
// schedule and answers a retired one with a 404 at request time, so keep the
// full set in one place for check-model-ids.ts to verify against the catalog.
export const openRouterModelIds = [
  ...new Set([
    ...chatModels.map((m) => baseOpenRouterId(m.id)),
    TITLE_MODEL,
    ARTIFACT_MODEL,
  ]),
];

// Group models by provider for UI
export const allowedModelIds = new Set(chatModels.map((m) => m.id));

export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);
