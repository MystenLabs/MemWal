import { Worker } from "node:worker_threads";

import { ChatbotError } from "@/lib/errors";

import { MAX_PDF_EXTRACT_MS, type PdfTextSource, collectPageText } from "./limits";

function tooSlow(): ChatbotError {
  return new ChatbotError(
    "bad_request:api",
    "This PDF took too long to read. Try a smaller or simpler PDF, or submit the source as a URL."
  );
}

function unreadable(message: string): ChatbotError {
  return new ChatbotError("bad_request:api", `Could not read this PDF: ${message}`);
}

type Pending = {
  resolve: (items: unknown[]) => void;
  reject: (error: unknown) => void;
};

/**
 * Extract a PDF's text with pdf.js running in a worker thread, under a
 * wall-clock deadline that ends the thread (WALM-683).
 *
 * The decompression guard bounds how much each stream inflates, but not how
 * often pdf.js decodes it: a stream shared by 300 pages, repeated in one page's
 * /Contents array, or drawn by a Form XObject invoked hundreds of times is
 * decoded on every use. pdf.js does that synchronously, so no check between
 * pages can interrupt it, and on the main thread it stalls every other request.
 * A worker can be terminated mid-page, and the main thread stays responsive
 * while it runs.
 *
 * Text selection is unchanged: collectPageText still decides the page limit,
 * the character budget and the joining rule; only getTextContent moved.
 */
export async function extractPdfTextIsolated(
  bytes: Uint8Array,
  options: { deadlineMs?: number } = {}
): Promise<string> {
  const deadlineMs = options.deadlineMs ?? MAX_PDF_EXTRACT_MS;
  // A copy the worker can own, so the caller's buffer is left alone.
  const owned = bytes.slice();
  // Keep this exact shape. Turbopack recognises `new Worker(new URL(...,
  // import.meta.url))` and bundles the worker, with unpdf, into its own chunk;
  // a computed path makes it trace the whole project and fail the build. tsx
  // resolves the same URL to the source file for the unit tests.
  const worker = new Worker(new URL("./pdf-text-worker.ts", import.meta.url), {
    workerData: { bytes: owned },
    transferList: [owned.buffer],
  });

  let failure: unknown = null;
  let opened: ((numPages: number) => void) | null = null;
  let openFailed: ((error: unknown) => void) | null = null;
  let pending: Pending | null = null;

  const fail = (error: unknown) => {
    if (failure) {
      return;
    }
    failure = error;
    openFailed?.(error);
    pending?.reject(error);
    pending = null;
  };

  const timer = setTimeout(() => {
    fail(tooSlow());
    void worker.terminate();
  }, deadlineMs);

  worker.on("message", (message: { type: string; numPages?: number; items?: unknown[]; message?: string }) => {
    if (message.type === "open") {
      opened?.(message.numPages ?? 0);
    } else if (message.type === "page") {
      const current = pending;
      pending = null;
      current?.resolve(message.items ?? []);
    } else if (message.type === "error") {
      fail(unreadable(message.message ?? "unknown error"));
    }
  });
  worker.on("error", (error) => fail(unreadable(error.message)));
  worker.on("exit", () => fail(unreadable("the reader stopped unexpectedly")));

  try {
    const numPages = await new Promise<number>((resolve, reject) => {
      opened = resolve;
      openFailed = reject;
      if (failure) {
        reject(failure);
      }
    });

    const source: PdfTextSource = {
      numPages,
      getPage: (pageNumber) =>
        Promise.resolve({
          getTextContent: () =>
            new Promise<{ items: unknown[] }>((resolve, reject) => {
              if (failure) {
                reject(failure);
                return;
              }
              pending = { resolve: (items) => resolve({ items }), reject };
              worker.postMessage({ type: "page", pageNumber });
            }),
        }),
    };

    return await collectPageText(source);
  } finally {
    clearTimeout(timer);
    // Also ends a document collectPageText stopped reading early.
    worker.removeAllListeners("exit");
    await worker.terminate();
  }
}
