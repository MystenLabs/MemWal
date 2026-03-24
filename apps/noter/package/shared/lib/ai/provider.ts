import { createOpenAI } from "@ai-sdk/openai";

export const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  headers: {
    "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    "X-Title": "Noter",
  },
});
