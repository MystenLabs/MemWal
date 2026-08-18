import { expect, test } from "@playwright/test";
import {
  STORAGE_STATE_USER_A,
  STORAGE_STATE_USER_B,
} from "../../../playwright.config";
import { postChatMessage } from "../helpers";

/**
 * The Private/Public boundary, pinned as it behaves today.
 *
 * Contexts here are created explicitly rather than via the `page` fixture,
 * because each test needs two identities. Note that `browser.newContext()`
 * inherits this project's `use.storageState` (user A), so every context that
 * must NOT be user A passes its own storage state explicitly — without it
 * the "other user" is silently user A and these tests pass for the wrong
 * reason.
 */
const ANONYMOUS = { cookies: [], origins: [] };

test.describe("Chat visibility", () => {
  test("private chat is not readable by another user", async ({
    browser,
    baseURL,
  }) => {
    const canary = `private-canary-${Date.now()}`;

    const contextA = await browser.newContext({
      baseURL,
      storageState: STORAGE_STATE_USER_A,
    });
    const { chatId } = await postChatMessage(contextA.request, baseURL!, {
      text: canary,
      visibility: "private",
    });

    const contextB = await browser.newContext({
      baseURL,
      storageState: STORAGE_STATE_USER_B,
    });
    const pageB = await contextB.newPage();
    await pageB.goto(`/chat/${chatId}`);

    // The route renders Next's not-found page. It does so with HTTP 200
    // rather than 404 because app/(chat)/chat/[id]/page.tsx wraps the async
    // component in <Suspense>, so the streaming shell is already flushed by
    // the time notFound() runs — assert on what the user actually gets.
    await expect(
      pageB.getByText(/This page could not be found/i)
    ).toBeVisible();
    await expect(pageB.getByText(canary)).toHaveCount(0);

    await contextA.close();
    await contextB.close();
  });

  test("public chat is readable by another signed-in user", async ({
    browser,
    baseURL,
  }) => {
    const canary = `public-canary-${Date.now()}`;

    const contextA = await browser.newContext({
      baseURL,
      storageState: STORAGE_STATE_USER_A,
    });
    const { chatId } = await postChatMessage(contextA.request, baseURL!, {
      text: canary,
      visibility: "public",
    });

    const contextB = await browser.newContext({
      baseURL,
      storageState: STORAGE_STATE_USER_B,
    });
    const pageB = await contextB.newPage();
    const response = await pageB.goto(`/chat/${chatId}`);

    expect(response?.status()).toBe(200);
    await expect(pageB.getByText(canary)).toBeVisible();

    await contextA.close();
    await contextB.close();
  });

  test("anonymous visitor is redirected to login even for a public chat", async ({
    browser,
    baseURL,
  }) => {
    const contextA = await browser.newContext({
      baseURL,
      storageState: STORAGE_STATE_USER_A,
    });
    const { chatId } = await postChatMessage(contextA.request, baseURL!, {
      text: `anon-canary-${Date.now()}`,
      visibility: "public",
    });

    // Known product gap: "Public — Anyone with the link" is not true for
    // logged-out visitors, because proxy.ts's auth check precedes the
    // visibility check. Pinned deliberately; update if that changes.
    const anonContext = await browser.newContext({
      baseURL,
      storageState: ANONYMOUS,
    });
    const anonPage = await anonContext.newPage();
    await anonPage.goto(`/chat/${chatId}`);
    await expect(anonPage).toHaveURL(/\/login$/);

    await contextA.close();
    await anonContext.close();
  });
});
