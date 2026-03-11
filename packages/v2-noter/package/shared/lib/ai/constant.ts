export const DEFAULT_MODEL = "anthropic/claude-sonnet-4";

export const MODELS = [
  { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "Anthropic" },
  { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku", provider: "Anthropic" },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "OpenAI" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "OpenAI" },
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", provider: "Google" },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];
