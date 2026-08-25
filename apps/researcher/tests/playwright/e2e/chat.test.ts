import { expect, test } from "@playwright/test";

// The mock chat model streams one of a small fixed set of responses
// (lib/ai/models.mock.ts), so an assistant bubble with stable text proves the
// full request → stream → render path.
test.describe("Chat", () => {
  let pageErrors: Error[];

  test.beforeEach(({ page }) => {
    pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));
  });

  test.afterEach(() => {
    expect(
      pageErrors,
      `Uncaught page errors: ${pageErrors.map((e) => e.message).join("; ")}`
    ).toHaveLength(0);
  });

  test("home page shows input and suggestions", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("multimodal-input")).toBeVisible();
    await expect(page.getByTestId("suggested-actions").first()).toBeVisible();
  });

  test("sending a message streams an assistant reply", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("multimodal-input").fill("Hello there");
    await page.getByTestId("send-button").click();

    // User bubble + assistant bubble.
    await expect(page.getByTestId("message-content")).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect(page.getByTestId("multimodal-input")).toHaveValue("");

    // Chat URL is claimed so the conversation is shareable/reloadable.
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/);
  });

  test("a finished chat survives reload with both messages", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("multimodal-input").fill("Hello persistence");
    await page.getByTestId("send-button").click();
    await expect(page.getByTestId("message-content")).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/);

    // Streaming has rendered; give persistence a beat, then reload the
    // permalink. Both rows must come back from the database — this guards
    // the missing-assistant-row symptom seen in production, and the
    // afterEach page-error assertion guards the auto-resume crash that
    // used to throw on reopening chats.
    await expect
      .poll(
        async () => {
          await page.reload();
          return page.getByTestId("message-content").count();
        },
        { timeout: 15_000 }
      )
      .toBe(2);
  });
});
