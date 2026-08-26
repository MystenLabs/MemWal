import { expect, test } from "@playwright/test";
import {
  framesOfType,
  postChatMessage,
  TITLE_FAILURE_SENTINEL,
} from "../helpers";

/**
 * Raw SSE assertions against /api/chat. These pin the exact production P0:
 * a rejected title generation used to surface as an `error` frame on the
 * stream, making every new chat render as failed even though the answer had
 * streamed fine underneath.
 */
test.describe("Chat stream protocol", () => {
  test("new chat streams text and a title with no error frames", async ({
    request,
    baseURL,
  }) => {
    const { response, frames } = await postChatMessage(request, baseURL!, {
      text: "Stream protocol check",
    });

    expect(response.status()).toBe(200);
    expect(framesOfType(frames, "text-delta").length).toBeGreaterThan(0);
    expect(framesOfType(frames, "error")).toHaveLength(0);

    const titleFrames = framesOfType(frames, "data-chat-title");
    expect(titleFrames).toHaveLength(1);
    expect(titleFrames[0].data).toBe("Test Conversation");
  });

  test("a failing title model never injects an error frame (P0 regression)", async ({
    request,
    baseURL,
    page,
  }) => {
    const { chatId, response, frames } = await postChatMessage(
      request,
      baseURL!,
      {
        // The sentinel makes the mock title model reject, reproducing the
        // retired-model 404 that broke production. The guard in
        // app/(chat)/api/chat/route.ts must swallow it.
        text: `Please explain ${TITLE_FAILURE_SENTINEL} to me`,
      }
    );

    expect(response.status()).toBe(200);
    // The answer still streams…
    expect(framesOfType(frames, "text-delta").length).toBeGreaterThan(0);
    // …the failed title never becomes a client-visible error…
    expect(framesOfType(frames, "error")).toHaveLength(0);
    // …and no title frame is emitted for the failed generation.
    expect(framesOfType(frames, "data-chat-title")).toHaveLength(0);

    // The chat itself is intact: it reloads with both messages and no
    // failure UI.
    await page.goto(`/chat/${chatId}`);
    await expect(page.getByTestId("message-content")).toHaveCount(2, {
      timeout: 15_000,
    });
  });
});
