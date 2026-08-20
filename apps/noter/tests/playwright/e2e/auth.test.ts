import { expect, test } from "@playwright/test";
import {
  openDelegateKeyForm,
  nextDelegateCredentials,
  readSessionId,
  signInWithDelegateKey,
} from "../fixtures/delegate-key";

test.describe("Delegate key authentication", () => {
  test("submit stays disabled until both fields are filled", async ({ page }) => {
    const { privateKey, accountId } = nextDelegateCredentials();
    await page.goto("/");
    await openDelegateKeyForm(page);

    const submit = page.getByRole("button", { name: "Sign In", exact: true });
    await expect(submit).toBeDisabled();

    await page.getByPlaceholder(/account id/i).fill(accountId);
    await expect(submit).toBeDisabled();

    await page.getByPlaceholder(/private key/i).fill(privateKey);
    await expect(submit).toBeEnabled();
  });

  test("signs in and lands on the notes route", async ({ page }) => {
    await signInWithDelegateKey(page);

    await expect(page).toHaveURL(/\/note(\/|$)/);
  });

  test("persists a session id for tRPC to authenticate with", async ({ page }) => {
    await signInWithDelegateKey(page);

    const sessionId = await readSessionId(page);
    expect(sessionId).toBeTruthy();
  });

  test("session survives a reload", async ({ page }) => {
    await signInWithDelegateKey(page);
    const before = await readSessionId(page);

    await page.reload();

    expect(await readSessionId(page)).toBe(before);
    await expect(page).toHaveURL(/\/note(\/|$)/);
  });

  test("does not sign in with a key that is not 64 hex characters", async ({ page }) => {
    const { accountId } = nextDelegateCredentials();
    await page.goto("/");
    await openDelegateKeyForm(page);

    await page.getByPlaceholder(/account id/i).fill(accountId);
    await page.getByPlaceholder(/private key/i).fill("deadbeef");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();

    // Server-side zod guard: /^[0-9a-f]{64}$/i — no session is issued.
    await expect(page.locator("p.text-destructive")).toContainText(/64 hex/i);
    await expect(page).toHaveURL("/");
    expect(await readSessionId(page)).toBeNull();
  });

  test("surfaces the delegate key validation error to the user", async ({ page }) => {
    const { accountId } = nextDelegateCredentials();
    await page.goto("/");
    await openDelegateKeyForm(page);

    await page.getByPlaceholder(/account id/i).fill(accountId);
    await page.getByPlaceholder(/private key/i).fill("deadbeef");
    await page.getByRole("button", { name: "Sign In", exact: true }).click();

    // Regression: useAuth.connectDelegateKey used to flip authAtom.isLoading
    // for the duration of the mutation, and app/page.tsx renders
    // <AuthButtonGroup /> only while `!isAuthenticated && !isLoading` — so the
    // form unmounted mid-submit, taking its `error` state with it before the
    // catch block could set it. connectDelegateKey/connectEnoki no longer
    // touch the global loading flag; isLoginPending (from the mutation hooks)
    // is what the submit button reads instead.
    await expect(page.locator("p.text-destructive")).toContainText(/64 hex/i);
  });

  test("stays on /note after sign-in instead of bouncing to the landing page", async ({ page }) => {
    const credentials = nextDelegateCredentials();

    await page.goto("/");
    await openDelegateKeyForm(page);
    await page.getByPlaceholder(/account id/i).fill(credentials.accountId);
    await page.getByPlaceholder(/private key/i).fill(credentials.privateKey);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();

    // Regression: sessionAtom used to be atomWithStorage(..., { getOnInit:
    // false }), so on the hard navigation triggered by
    // window.location.href = "/note" the session was still null on first
    // render. useAuth's effect took the `!session && !auth.isAuthenticated`
    // branch and cleared isLoading before sessionStorage had hydrated, and
    // /note's guard fired router.replace("/") — bouncing an authenticated
    // user back to the landing page. sessionAtom now reads sessionStorage
    // synchronously on first render (getOnInit: true), so no such gap exists.
    await page.waitForURL(/\/note(\/|$)/);
    await expect(page).toHaveURL(/\/note(\/|$)/);
  });

  test("two sign-ins with different keys produce different sessions", async ({ page }) => {
    await signInWithDelegateKey(page);
    const first = await readSessionId(page);

    await page.evaluate(() => sessionStorage.clear());
    await signInWithDelegateKey(page);
    const second = await readSessionId(page);

    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});
