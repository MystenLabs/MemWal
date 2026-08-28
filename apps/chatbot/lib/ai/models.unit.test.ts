import { describe, expect, it } from "vitest";
import {
  allowedModelIds,
  ARTIFACT_MODEL,
  baseOpenRouterId,
  chatModels,
  DEFAULT_CHAT_MODEL,
  isReasoningModelId,
  openRouterModelIds,
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
