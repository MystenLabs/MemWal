// pdf.js text extraction, off the main thread (WALM-683).
//
// Started by pdf-text-host.ts with `new Worker(new URL(...))`; Turbopack
// bundles it as its own worker chunk. Keep it small and free of `@/` imports
// and app state: it runs in a separate thread. Everything that decides *what*
// text is kept (the page limit, the character budget, how items are joined)
// stays in collectPageText on the main thread; this only opens the document
// and hands back each page's text items when asked.
//
// Why a worker at all: pdf.js decodes a page synchronously. A content stream
// shared by many pages, repeated in a /Contents array, or drawn by a Form
// XObject that is invoked many times is decoded once per use, so a file the
// decompression guard accepts can still hold the thread for minutes — and on
// the main thread that stalls every request the server is handling. Here the
// host can terminate the thread at its deadline, which stops the work outright.

import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

const port = parentPort;
if (!port) {
  throw new Error("pdf-text-worker must run in a worker thread");
}

let doc: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;

try {
  doc = await getDocumentProxy(new Uint8Array(workerData.bytes));
  port.postMessage({ type: "open", numPages: doc.numPages });
} catch (error) {
  port.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}

port.on("message", async (message: { type?: string; pageNumber: number }) => {
  if (message?.type !== "page" || !doc) {
    return;
  }
  try {
    const page = await doc.getPage(message.pageNumber);
    const content = await page.getTextContent();
    page.cleanup();
    // Only what collectPageText reads. Items without `str` (marked content)
    // are dropped here rather than cloned across and dropped there.
    const items: { str: string; hasEOL: boolean }[] = [];
    for (const item of content.items) {
      if (item && typeof item === "object" && "str" in item && item.str != null) {
        items.push({ str: String(item.str), hasEOL: "hasEOL" in item && Boolean(item.hasEOL) });
      }
    }
    port.postMessage({ type: "page", pageNumber: message.pageNumber, items });
  } catch (error) {
    port.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
