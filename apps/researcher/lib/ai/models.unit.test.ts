import assert from "node:assert/strict";
import test from "node:test";
import { chatModels, DEFAULT_CHAT_MODEL, TITLE_MODEL } from "./models";

// Regression guard for the 2026-08 incident: getTitleModel() hardcoded
// "google/gemini-2.0-flash-001", which OpenRouter retired. Every chat's title
// call 404'd, and because the await was unguarded the rejection tore down the
// whole response stream — users got no answer at all.
//
// These assertions cannot detect a model being retired upstream (that needs a
// live call). What they do catch is the structural cause: a title/default model
// drifting away from the curated set that the rest of the app maintains.

const ids = new Set(chatModels.map((m) => m.id));

test("TITLE_MODEL is a curated, supported model", () => {
  assert.ok(
    ids.has(TITLE_MODEL),
    `TITLE_MODEL "${TITLE_MODEL}" is not in chatModels — background title generation would call a model the app does not otherwise support`
  );
});

test("DEFAULT_CHAT_MODEL is a curated, supported model", () => {
  assert.ok(
    ids.has(DEFAULT_CHAT_MODEL),
    `DEFAULT_CHAT_MODEL "${DEFAULT_CHAT_MODEL}" is not in chatModels`
  );
});

test("retired model ids are not offered or referenced", () => {
  // Retired upstream; kept here so they cannot be reintroduced by copy-paste.
  // All three verified against OpenRouter with the production key on
  // 2026-08-17: each returns 404 "No endpoints found".
  const retired = [
    "google/gemini-2.0-flash-001",
    "anthropic/claude-3.5-haiku",
    "anthropic/claude-3.5-sonnet",
  ];
  for (const id of retired) {
    assert.ok(!ids.has(id), `retired model "${id}" is still in chatModels`);
    assert.notEqual(TITLE_MODEL, id, `TITLE_MODEL points at retired "${id}"`);
    assert.notEqual(
      DEFAULT_CHAT_MODEL,
      id,
      `DEFAULT_CHAT_MODEL points at retired "${id}"`
    );
  }
});

test("chatModels entries are unique and well formed", () => {
  assert.equal(ids.size, chatModels.length, "duplicate model ids in chatModels");
  for (const m of chatModels) {
    assert.ok(m.id.includes("/"), `model id "${m.id}" is not provider-qualified`);
    assert.ok(m.name.length > 0, `model "${m.id}" has no display name`);
  }
});
