import { Worker } from "node:worker_threads";

import { ChatbotError } from "@/lib/errors";

import {
  MAX_PDF_EXTRACT_MS,
  MAX_PDF_QUEUE,
  MAX_PDF_WORKER_HEAP_MB,
  MAX_PDF_WORKERS,
  type PdfTextSource,
  collectPageText,
} from "./limits";

function tooSlow(): ChatbotError {
  return new ChatbotError(
    "bad_request:api",
    "This PDF took too long to read. Try a smaller or simpler PDF, or submit the source as a URL."
  );
}

/**
 * The detail goes to the log, not the client: a worker failure can carry a
 * server path (a chunk that failed to load), and pdf.js's own messages are
 * implementation detail.
 */
function unreadable(detail: string): ChatbotError {
  console.error(`[ingest] PDF reader failed: ${detail}`);
  return new ChatbotError(
    "bad_request:api",
    "Could not read this PDF. Please use a text-based PDF or submit the source as a URL."
  );
}

function busy(): ChatbotError {
  return new ChatbotError(
    "rate_limit:api",
    "Too many PDFs are being read right now. Please try again in a minute."
  );
}

// ── concurrency ──────────────────────────────────────────────────────────
// Process-wide: at most `limit` readers at once, at most `queue` uploads
// waiting, and none waiting longer than `waitMs`.

let activeReaders = 0;
const waitingReaders: Array<() => void> = [];

function releaseReader(): void {
  activeReaders--;
  waitingReaders.shift()?.();
}

export async function acquireReaderSlot(
  waitMs: number,
  limit: number = MAX_PDF_WORKERS,
  queue: number = MAX_PDF_QUEUE
): Promise<() => void> {
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseReader();
    }
  };

  if (activeReaders < limit) {
    activeReaders++;
    return release;
  }
  if (waitingReaders.length >= queue) {
    throw busy();
  }

  return new Promise<() => void>((resolve, reject) => {
    const admit = () => {
      clearTimeout(timer);
      activeReaders++;
      resolve(release);
    };
    const timer = setTimeout(() => {
      const index = waitingReaders.indexOf(admit);
      if (index !== -1) {
        waitingReaders.splice(index, 1);
      }
      reject(busy());
    }, waitMs);
    waitingReaders.push(admit);
  });
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
  // Waiting for a reader is bounded by one deadline too, so an upload spends at
  // most two deadlines here in total.
  const release = await acquireReaderSlot(deadlineMs);
  try {
    return await readInWorker(bytes, deadlineMs);
  } finally {
    release();
  }
}

async function readInWorker(bytes: Uint8Array, deadlineMs: number): Promise<string> {
  // A real copy the worker can own. `bytes.slice()` would share memory when a
  // Node Buffer is passed, and transferring it would empty the caller's buffer.
  const owned = new Uint8Array(bytes);
  // Keep this exact shape. Turbopack recognises `new Worker(new URL(...,
  // import.meta.url))` and bundles the worker, with unpdf, into its own chunk;
  // a computed path makes it trace the whole project and fail the build. tsx
  // resolves the same URL to the source file for the unit tests.
  const worker = new Worker(new URL("./pdf-text-worker.ts", import.meta.url), {
    workerData: { bytes: owned },
    transferList: [owned.buffer],
    // Bounds the JS heap only; decoded stream buffers live outside it, which is
    // why the reader count above is the main memory control.
    resourceLimits: { maxOldGenerationSizeMb: MAX_PDF_WORKER_HEAP_MB },
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
