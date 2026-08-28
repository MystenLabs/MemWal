import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedModelIds,
  ARTIFACT_MODEL,
  baseOpenRouterId,
  chatModels,
  DEFAULT_CHAT_MODEL,
  isReasoningModelId,
  MAX_OUTPUT_TOKENS,
  MAX_REASONING_OUTPUT_TOKENS,
  openRouterModelIds,
  resolveChatModelId,
  TITLE_MODEL,
} from "./models";

// apps/researcher hit this in 2026-08: getTitleModel() hardcoded
// "google/gemini-2.0-flash-001", OpenRouter retired it, and every title call
// 404'd. The chatbot carried the same three ids. Nothing here can tell that a
// model was retired upstream — that needs a live call — but these assertions do
// catch the structural cause: an id drifting away from the curated set.
const RETIRED_IDS = [
  "google/gemini-2.0-flash-001",
  "anthropic/claude-3.5-haiku",
  "anthropic/claude-3.5-sonnet",
];

describe("curated model list", () => {
  it("points the background models at models the app also offers", () => {
    // Titles and artifacts are generated outside the picker, so a bad id here
    // breaks those features for everyone rather than only whoever selects it.
    expect(allowedModelIds.has(TITLE_MODEL)).toBe(true);
    expect(allowedModelIds.has(ARTIFACT_MODEL)).toBe(true);
    expect(allowedModelIds.has(DEFAULT_CHAT_MODEL)).toBe(true);
  });

  it("never reintroduces a retired id", () => {
    for (const id of RETIRED_IDS) {
      expect(allowedModelIds.has(id)).toBe(false);
      expect(TITLE_MODEL).not.toBe(id);
      expect(ARTIFACT_MODEL).not.toBe(id);
      expect(DEFAULT_CHAT_MODEL).not.toBe(id);
      expect(openRouterModelIds).not.toContain(id);
    }
  });

  it("keeps entries unique and provider-qualified", () => {
    expect(allowedModelIds.size).toBe(chatModels.length);
    for (const model of chatModels) {
      expect(model.id).toContain("/");
      expect(model.name.length).toBeGreaterThan(0);
    }
  });

  it("strips the -thinking marker before a request leaves the app", () => {
    // OpenRouter has no "-thinking" id; sending one unstripped is a 404.
    expect(isReasoningModelId("anthropic/claude-sonnet-4.5-thinking")).toBe(true);
    expect(isReasoningModelId("openai/gpt-4o-mini")).toBe(false);
    expect(baseOpenRouterId("anthropic/claude-sonnet-4.5-thinking")).toBe(
      "anthropic/claude-sonnet-4.5"
    );
    for (const id of openRouterModelIds) {
      expect(id.endsWith("-thinking")).toBe(false);
    }
  });
});

describe("chat-model cookie resolution", () => {
  it("keeps ids the chat API still accepts", () => {
    for (const model of chatModels) {
      expect(resolveChatModelId(model.id)).toBe(model.id);
    }
  });

  it("falls back to the default for missing, empty or retired ids", () => {
    for (const value of [...RETIRED_IDS, "not-a-model", "", "  "]) {
      expect(resolveChatModelId(value)).toBe(DEFAULT_CHAT_MODEL);
    }
    expect(resolveChatModelId(undefined)).toBe(DEFAULT_CHAT_MODEL);
  });

  // Both chat pages read the cookie server-side and hand it to <Chat>, which
  // sends it as selectedChatModel, so passing cookie.value straight through is
  // what made a retired id reject every send. Guard the call sites too.
  it.each([["app/(chat)/page.tsx"], ["app/(chat)/chat/[id]/page.tsx"]])(
    "routes the cookie through the resolver in %s",
    (page) => {
      const source = readFileSync(resolve(page), "utf8");
      expect(source).toMatch(
        /resolveChatModelId\(\s*cookieStore\.get\("chat-model"\)\?\.value\s*\)/
      );
      expect(source).not.toMatch(/initialChatModel=\{\w*[Cc]ookie\w*\.value\}/);
    }
  );
});

const MODEL_CALL_REGEX = /\b(streamText|streamObject|generateText|generateObject)\(/g;
const MAX_OUTPUT_TOKENS_REGEX = /maxOutputTokens:/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (entry.name.includes(".test.") || !/\.tsx?$/.test(extname(path))) {
      return [];
    }
    return [path];
  });
}

describe("output token caps", () => {
  it("keeps the reasoning cap above the thinking budget the chat route asks for", () => {
    const route = readFileSync(resolve("app/(chat)/api/chat/route.ts"), "utf8");
    const budget = route.match(/budgetTokens:\s*([\d_]+)/);

    expect(budget).not.toBeNull();
    expect(MAX_REASONING_OUTPUT_TOKENS).toBeGreaterThan(
      Number((budget?.[1] ?? "0").replace(/_/g, ""))
    );
  });

  // An uncapped call is quoted against the model's whole output window, which
  // Anthropic and Google reject for credit up front. Counting call sites rather
  // than naming them is deliberate: the by-hand sweep that introduced the caps
  // missed requestSuggestions, and a named list would have missed it again.
  it("caps every model call in the app", () => {
    const uncapped = ["app", "artifacts", "lib"]
      .flatMap((dir) => sourceFiles(resolve(dir)))
      .map((path) => {
        const source = readFileSync(path, "utf8");
        return {
          path,
          calls: source.match(MODEL_CALL_REGEX)?.length ?? 0,
          caps: source.match(MAX_OUTPUT_TOKENS_REGEX)?.length ?? 0,
        };
      })
      .filter((file) => file.calls > file.caps)
      .map((file) => `${file.path} (${file.calls} calls, ${file.caps} capped)`);

    expect(uncapped).toEqual([]);
  });

  it("keeps the caps small enough to be the point of having them", () => {
    expect(MAX_OUTPUT_TOKENS).toBeLessThan(32_000);
    expect(MAX_REASONING_OUTPUT_TOKENS).toBeLessThan(32_000);
  });
});
