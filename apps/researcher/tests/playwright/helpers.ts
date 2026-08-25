import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { TestAccount } from "./fixtures/test-accounts";

/**
 * Mirrors TITLE_FAILURE_SENTINEL in lib/ai/models.mock.ts (kept as a copy so
 * specs don't import app code through Playwright's transpiler). A user
 * message containing it makes the mock title model reject, reproducing the
 * retired-title-model production failure.
 */
export const TITLE_FAILURE_SENTINEL = "FAIL_TITLE_GENERATION";

/** Default id from lib/ai/models.ts — must be in the route's allowlist. */
export const DEFAULT_CHAT_MODEL_ID = "google/gemini-2.5-flash";

/**
 * Log in through the API from a browser-context request so the session
 * cookie lands on the context. The route enforces same-origin, so the
 * Origin header must match the app host.
 */
export async function loginViaApi(
  request: APIRequestContext,
  baseURL: string,
  account: TestAccount
): Promise<void> {
  const res = await request.post("/api/auth/key", {
    headers: { origin: baseURL },
    data: {
      privateKey: account.privateKey,
      accountId: account.accountId,
    },
  });
  if (!res.ok()) {
    throw new Error(
      `Login failed for ${account.accountId}: ${res.status()} ${await res.text()}`
    );
  }
}

export type PostChatResult = {
  chatId: string;
  response: APIResponse;
  body: string;
  frames: Array<Record<string, unknown>>;
};

/**
 * Send one user message to /api/chat and return the parsed SSE data frames.
 * The response only resolves once the stream has fully drained, so callers
 * can assert on the complete frame sequence.
 */
export async function postChatMessage(
  request: APIRequestContext,
  baseURL: string,
  {
    text,
    chatId = randomUUID(),
    visibility = "private",
  }: {
    text: string;
    chatId?: string;
    visibility?: "public" | "private";
  }
): Promise<PostChatResult> {
  const response = await request.post("/api/chat", {
    headers: { origin: baseURL },
    data: {
      id: chatId,
      message: {
        id: randomUUID(),
        role: "user",
        parts: [{ type: "text", text }],
      },
      selectedChatModel: DEFAULT_CHAT_MODEL_ID,
      selectedVisibilityType: visibility,
    },
  });

  const body = await response.text();
  return { chatId, response, body, frames: parseSseFrames(body) };
}

/** Parse `data: {...}` SSE lines into JSON frames, skipping non-JSON lines. */
export function parseSseFrames(body: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      // ignore non-JSON data lines
    }
  }
  return frames;
}

export function framesOfType(
  frames: Array<Record<string, unknown>>,
  type: string
): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame.type === type);
}
