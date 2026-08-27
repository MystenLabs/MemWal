import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import {
  STORAGE_STATE_USER_A,
  STORAGE_STATE_USER_B,
} from "../../playwright.config";
import { TEST_ACCOUNT_A, TEST_ACCOUNT_B } from "./fixtures/test-accounts";
import { loginViaApi } from "./helpers";

/**
 * Signs in once through the real delegate-key form and saves the session
 * cookie as storage state for the e2e project. Doubles as the happy-path
 * login test: if the form, the /api/auth/key route, or the binding check
 * regress, everything downstream fails here with a precise error.
 */
setup("sign in with delegate key", async ({ page }) => {
  await page.goto("/login");

  await page
    .getByRole("button", { name: "Sign in with delegate key" })
    .click();
  await page.locator("#accountId").fill(TEST_ACCOUNT_A.accountId);
  await page.locator("#privateKey").fill(TEST_ACCOUNT_A.privateKey);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();

  await page.waitForURL("/");
  await expect(page.getByTestId("multimodal-input")).toBeVisible();

  mkdirSync(path.dirname(STORAGE_STATE_USER_A), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE_USER_A });
});

/**
 * Second identity for cross-account tests, signed in through the API rather
 * than the form (the form is already covered above). Done once here so the
 * visibility specs don't spend a verify-bucket slot each — the limiter allows
 * 10 per IP per minute, and CI retries would exhaust that.
 */
setup("sign in as the second account", async ({ request, baseURL }) => {
  await loginViaApi(request, baseURL!, TEST_ACCOUNT_B);

  mkdirSync(path.dirname(STORAGE_STATE_USER_B), { recursive: true });
  await request.storageState({ path: STORAGE_STATE_USER_B });
});
