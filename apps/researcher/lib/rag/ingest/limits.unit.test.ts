import assert from "node:assert/strict";
import test from "node:test";

import { ChatbotError } from "@/lib/errors";

import {
  MAX_SOURCE_BYTES,
  assertLooksLikePdf,
  assertSourceFileWithinBudget,
  capExtractedText,
  MAX_EXTRACTED_CHARS,
  readCappedBytes,
  readCappedText,
} from "./limits";

/**
 * `ChatbotError` keeps a generic user-facing `message` and puts the specific
 * reason in `cause`, so assertions go against `cause`.
 */
function causeMatches(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ChatbotError, `expected a ChatbotError, got ${error}`);
    assert.match(String(error.cause), pattern);
    return true;
  };
}

function streamingResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {}
): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  // Chunks are produced on demand rather than enqueued up front, so the stream
  // is still open when a cap rejects mid-read — which is the state a real
  // download is in, and the only state where cancelling it means anything.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    response: new Response(stream, { headers }),
    cancelled: () => cancelled,
  };
}

test("readCappedBytes returns a body that fits the budget", async () => {
  const { response } = streamingResponse([
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4, 5]),
  ]);

  const bytes = await readCappedBytes(response, 16);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
});

test("readCappedBytes refuses a body that exceeds the cap mid-stream", async () => {
  // No Content-Length at all: the running total is what has to stop this, not
  // anything the remote side declared.
  const { response } = streamingResponse([
    new Uint8Array(8),
    new Uint8Array(8),
    new Uint8Array(8),
  ]);

  await assert.rejects(() => readCappedBytes(response, 16), causeMatches(/larger than/));
});

test("readCappedBytes does not trust an understated Content-Length", async () => {
  // The header claims one byte; the body sends far more. A limiter that trusted
  // the header would buffer all of it.
  const { response } = streamingResponse(
    [new Uint8Array(64), new Uint8Array(64)],
    { "content-length": "1" }
  );

  await assert.rejects(() => readCappedBytes(response, 32), causeMatches(/larger than/));
});

test("readCappedBytes rejects an oversized Content-Length before reading", async () => {
  const { response, cancelled } = streamingResponse([new Uint8Array(4)], {
    "content-length": String(MAX_SOURCE_BYTES + 1),
  });

  await assert.rejects(() => readCappedBytes(response), causeMatches(/larger than/));
  assert.equal(cancelled(), true, "the transfer must be cancelled, not left running");
});

test("readCappedBytes cancels the stream when it rejects mid-read", async () => {
  // "A rejection does not leave partial unbounded work running."
  const { response, cancelled } = streamingResponse([
    new Uint8Array(8),
    new Uint8Array(8),
  ]);

  await assert.rejects(() => readCappedBytes(response, 8), causeMatches(/larger than/));
  assert.equal(cancelled(), true);
});

test("readCappedText decodes within the same budget", async () => {
  const { response } = streamingResponse([new TextEncoder().encode("hello")]);
  assert.equal(await readCappedText(response, 32), "hello");
});

test("assertSourceFileWithinBudget rejects a non-File form value", () => {
  // The route used `formData.get("file") as File`, which a plain text field
  // satisfies at runtime.
  assert.throws(
    () => assertSourceFileWithinBudget("not-a-file" as unknown as File),
    causeMatches(/Expected a PDF file/)
  );
  assert.throws(() => assertSourceFileWithinBudget(null), causeMatches(/Expected a PDF file/));
});

test("assertSourceFileWithinBudget rejects an oversized upload", () => {
  const huge = new File([new Uint8Array(4)], "big.pdf");
  Object.defineProperty(huge, "size", { value: MAX_SOURCE_BYTES + 1 });

  assert.throws(() => assertSourceFileWithinBudget(huge), causeMatches(/larger than/));
});

test("assertSourceFileWithinBudget accepts a file inside the budget", () => {
  const file = new File([new Uint8Array(8)], "fine.pdf");
  assert.equal(assertSourceFileWithinBudget(file), file);
});

test("assertLooksLikePdf checks content, not the filename", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\nbody");
  assert.doesNotThrow(() => assertLooksLikePdf(pdf));

  // A .pdf suffix on something that is not a PDF was the only check before.
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
  assert.throws(() => assertLooksLikePdf(zip), causeMatches(/not a PDF/));
  assert.throws(() => assertLooksLikePdf(new Uint8Array([0x25])), causeMatches(/not a PDF/));
  assert.throws(() => assertLooksLikePdf(new Uint8Array()), causeMatches(/not a PDF/));
});

test("capExtractedText truncates past the character budget", () => {
  const short = "a".repeat(32);
  assert.equal(capExtractedText(short), short);

  const long = "a".repeat(MAX_EXTRACTED_CHARS + 500);
  assert.equal(capExtractedText(long).length, MAX_EXTRACTED_CHARS);
});
