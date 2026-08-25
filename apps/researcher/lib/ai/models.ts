// Curated list of models available on OpenRouter
export const DEFAULT_CHAT_MODEL = "google/gemini-2.5-flash";

/**
 * Model used for background chat-title generation.
 *
 * Declared here beside the curated list rather than hardcoded at the call site:
 * the previous inline "google/gemini-2.0-flash-001" was retired upstream and
 * returned 404 on every chat, and nothing tied it back to the models we
 * actually support. Keep this pointing at a model present in `chatModels`.
 */
export const TITLE_MODEL = "google/gemini-2.5-flash";

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

export const chatModels: ChatModel[] = [
  // Google (default for research)
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    description: "Fast and capable — great for research tasks",
  },
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
  // DeepSeek
  {
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek V3",
    provider: "deepseek",
    description: "Strong open-source model",
  },
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

/**
 * Coerce a persisted `chat-model` cookie to a model we actually support.
 *
 * The cookie outlives the curated list: anyone who had a since-retired model
 * selected keeps sending that id, and `/api/chat` rejects unknown ids with a
 * 400. The picker's own fallback is display-only — it renders the default name
 * while `initialChatModel` still carries the stale id into the request body —
 * so the coercion has to happen where the cookie is read.
 */
export function resolveChatModelId(cookieValue: string | undefined): string {
  return cookieValue && allowedModelIds.has(cookieValue)
    ? cookieValue
    : DEFAULT_CHAT_MODEL;
}
