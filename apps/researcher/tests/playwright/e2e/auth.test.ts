import { expect, test } from "@playwright/test";
import {
  TEST_ACCOUNT_A,
  UNKNOWN_ACCOUNT_ID,
  UNREGISTERED_PRIVATE_KEY,
} from "../fixtures/test-accounts";

// Auth negatives run without the shared signed-in session.
test.use({ storageState: { cookies: [], origins: [] } });

async function submitDelegateLogin(
  page: import("@playwright/test").Page,
  accountId: string,
  privateKey: string
) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with delegate key" }).click();
  await page.locator("#accountId").fill(accountId);
  await page.locator("#privateKey").fill(privateKey);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
}

test.describe("Authentication", () => {
  test("anonymous visitor is redirected to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("anonymous visitor cannot open a chat URL", async ({ page }) => {
    await page.goto("/chat/00000000-0000-4000-8000-000000000000");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("unregistered delegate key is rejected", async ({ page }) => {
    await submitDelegateLogin(
      page,
      TEST_ACCOUNT_A.accountId,
      UNREGISTERED_PRIVATE_KEY
    );
    await expect(page.getByTestId("toast")).toContainText(
      /not registered/i
    );
    await expect(page).toHaveURL(/\/login$/);
  });

  test("unknown account id is rejected", async ({ page }) => {
    await submitDelegateLogin(
      page,
      UNKNOWN_ACCOUNT_ID,
      TEST_ACCOUNT_A.privateKey
    );
    await expect(page.getByTestId("toast")).toContainText(
      /unable to verify/i
    );
    await expect(page).toHaveURL(/\/login$/);
  });

  test("malformed private key is rejected with a clear message", async ({
    page,
  }) => {
    await submitDelegateLogin(page, TEST_ACCOUNT_A.accountId, "not-a-key");
    await expect(page.getByTestId("toast")).toContainText(
      /invalid private key/i
    );
    await expect(page).toHaveURL(/\/login$/);
  });
});
