import { expect, test } from "@playwright/test";
import { gotoNotes, signInWithDelegateKey } from "../fixtures/delegate-key";

const NOTE_URL = /\/note\/[0-9a-f-]{36}$/i;

test.describe("Note lifecycle", () => {
  test("a fresh user sees the empty state", async ({ page }) => {
    await signInWithDelegateKey(page);

    await expect(page).toHaveURL(/\/note$/);
    await expect(page.getByRole("heading", { name: "No notes yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: /create your first note/i })).toBeVisible();
  });

  test("creating the first note opens its editor", async ({ page }) => {
    await signInWithDelegateKey(page);

    await page.getByRole("button", { name: /create your first note/i }).click();

    await expect(page).toHaveURL(NOTE_URL);
    await expect(page.locator(".note-editor-content")).toBeVisible();
  });

  test("a created note outlives the page that created it", async ({ page }) => {
    await signInWithDelegateKey(page);
    await page.getByRole("button", { name: /create your first note/i }).click();
    await expect(page).toHaveURL(NOTE_URL);

    // Cold-load the notes route: the empty state must be gone and /note must
    // forward to the persisted note.
    await gotoNotes(page);

    await expect(page).toHaveURL(NOTE_URL);
    await expect(page.getByRole("heading", { name: /no notes yet/i })).toBeHidden();
    await expect(page.locator(".note-editor-content")).toBeVisible();
  });

  test("editor content is autosaved and survives a cold load", async ({ page }) => {
    const body = `Playwright autosave check ${Date.now()}`;

    await signInWithDelegateKey(page);
    await page.getByRole("button", { name: /create your first note/i }).click();
    await expect(page).toHaveURL(NOTE_URL);

    const editor = page.locator(".note-editor-content");
    await editor.click();

    // Saves are debounced 3s (use-note.ts) from the last keystroke. Wait for
    // the actual note.update response instead of a fixed timeout — a bare
    // sleep race against the debounce window is exactly what flaked here.
    const saved = page.waitForResponse(
      (res) => res.url().includes("/api/trpc/note.update") && res.ok(),
      { timeout: 10_000 },
    );
    await editor.pressSequentially(body, { delay: 10 });
    await expect(editor).toContainText(body);
    await saved;

    await gotoNotes(page);

    await expect(page.locator(".note-editor-content")).toContainText(body);
  });

  test("notes belong to their own user", async ({ page }) => {
    await signInWithDelegateKey(page);
    await page.getByRole("button", { name: /create your first note/i }).click();
    await expect(page).toHaveURL(NOTE_URL);

    // Re-authenticate as a different delegate key — the previous note must not leak.
    await page.evaluate(() => sessionStorage.clear());
    await signInWithDelegateKey(page);

    await expect(page).toHaveURL(/\/note$/);
    await expect(page.getByRole("heading", { name: "No notes yet" })).toBeVisible();
  });
});
