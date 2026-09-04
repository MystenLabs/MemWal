import { expect, test } from "@playwright/test";

// The mock provider answers a greeting with "Hello! How can I help you today?",
// a weather question with a fixed forecast, and anything else with "This is a
// mock response for testing." (lib/ai/models.mock.ts).
const MOCK_GREETING = /How can I help you today/i;
const MOCK_DEFAULT = /mock response for testing/i;
const MOCK_WEATHER = /sunny and 72/i;
const MODEL_BUTTON_REGEX = /Gemini|Claude|GPT|Grok/i;

test.describe("Conversation", () => {
  test("streams an assistant reply back into the thread", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("multimodal-input").fill("Hello there");
    await page.getByTestId("send-button").click();

    const assistantMessage = page
      .locator('[data-role="assistant"]')
      .getByTestId("message-content")
      .first();

    await expect(assistantMessage).toContainText(MOCK_GREETING, {
      timeout: 20_000,
    });
  });

  test("keeps the reply after reloading the chat", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("multimodal-input").fill("Tell me something");
    await page.getByTestId("send-button").click();

    const assistantMessage = page
      .locator('[data-role="assistant"]')
      .getByTestId("message-content")
      .first();
    await expect(assistantMessage).toContainText(MOCK_DEFAULT, {
      timeout: 20_000,
    });

    // Sending redirects `/` to /chat/<id>; both the user turn and the assistant
    // turn have to come back from the database on a cold load.
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 20_000 });
    await page.reload();

    await expect(page.getByTestId("message-content").first()).toContainText(
      "Tell me something"
    );
    await expect(
      page.locator('[data-role="assistant"]').getByTestId("message-content").first()
    ).toContainText(MOCK_DEFAULT);
  });

  test("routes the question to the model instead of a fixed reply", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByTestId("multimodal-input")
      .fill("What is the weather in San Francisco?");
    await page.getByTestId("send-button").click();

    await expect(
      page.locator('[data-role="assistant"]').getByTestId("message-content").first()
    ).toContainText(MOCK_WEATHER, { timeout: 20_000 });
  });

  test("titles the chat in the sidebar", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("multimodal-input").fill("Hello there");
    await page.getByTestId("send-button").click();

    // The title comes from its own model call, separate from the reply. When
    // that model id was retired upstream every chat stayed named "New chat".
    await expect(
      page.getByRole("link", { name: /Test Conversation/i })
    ).toBeVisible({ timeout: 20_000 });
  });

  test("streams reasoning for a thinking model", async ({ page }) => {
    await page.goto("/");
    await page
      .locator("button")
      .filter({ hasText: MODEL_BUTTON_REGEX })
      .first()
      .click();
    await page.getByText(/Claude Sonnet [\d.]+ \(Thinking\)/i).first().click();

    await page.getByTestId("multimodal-input").fill("Solve this puzzle");
    await page.getByTestId("send-button").click();

    await expect(page.getByTestId("message-reasoning").first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("creates a text artifact through the retired-id-safe artifact model", async ({
    page,
  }) => {
    // ARTIFACT_MODEL used to be a retired OpenRouter id, so createDocument
    // 404'd before any panel opened. The mock emits the same tool call the
    // chat model would, then the artifact model fills the document.
    await page.goto("/");
    await page
      .getByTestId("multimodal-input")
      .fill("Create a document about Silicon Valley");
    await page.getByTestId("send-button").click();

    const preview = page.getByTestId("document-preview");
    await expect(preview).toBeVisible({ timeout: 20_000 });
    await expect(preview).toContainText("Test Artifact");

    await preview.click();
    await expect(page.getByTestId("artifact")).toBeVisible();
  });

  test("recovers when the chat-model cookie holds a retired id", async ({
    page,
    context,
  }) => {
    // Ids leave chatModels whenever OpenRouter retires a model, but a returning
    // reader still carries the old one. Passing it through made /api/chat reject
    // every send as a bad request while the picker showed a valid model.
    await context.addCookies([
      {
        name: "chat-model",
        value: "anthropic/claude-3.5-sonnet",
        domain: "localhost",
        path: "/",
      },
    ]);

    await page.goto("/");
    await page.getByTestId("multimodal-input").fill("Hello there");
    await page.getByTestId("send-button").click();

    await expect(
      page.locator('[data-role="assistant"]').getByTestId("message-content").first()
    ).toContainText(MOCK_GREETING, { timeout: 20_000 });
  });
});
