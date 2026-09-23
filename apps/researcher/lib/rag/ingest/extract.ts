import "server-only";

import { ChatbotError } from "@/lib/errors";
import { getDocumentProxy } from "unpdf";

import {
  MAX_SOURCE_BYTES,
  assertLooksLikePdf,
  assertSourceFileWithinBudget,
  collectPageText,
  discardBody,
  readCappedText,
} from "./limits";
import { assertPdfDecompressionWithinBudget } from "./pdf-guard";

export const JINA_READER_URL = "https://r.jina.ai/";

export async function extractFromUrl(url: string): Promise<string> {
  const response = await fetch(`${JINA_READER_URL}${url}`, {
    headers: { Accept: "text/markdown" },
  });

  if (!response.ok) {
    await discardBody(response);
    throw new ChatbotError(
      "bad_request:api",
      `Jina Reader failed to extract content from URL: ${response.statusText}`
    );
  }

  // Jina is a third party streaming into our memory; its response is capped
  // like any other source rather than buffered whole (WALM-683).
  const text = await readCappedText(response, MAX_SOURCE_BYTES);
  if (!text || text.trim().length === 0) {
    throw new ChatbotError("bad_request:api", "Extracted content is empty");
  }

  return text;
}

export async function extractFromPdf(file: File): Promise<string> {
  // A second check, not the byte budget: by the time a File exists its bytes are
  // already in memory. The budget itself is enforced where the bytes arrive —
  // the capped request read in the route, and readCappedBytes for downloads.
  // The magic-byte check is what makes this a PDF check at all; the caller only
  // ever saw a filename.
  const buffer = new Uint8Array(
    await assertSourceFileWithinBudget(file).arrayBuffer()
  );
  assertLooksLikePdf(buffer);

  // Before pdf.js touches it: pdf.js inflates each stream in full with no
  // ceiling, so a small file can expand to gigabytes before any cap below runs.
  // This measures every compressed stream first and refuses the file if any of
  // them would expand past the budget.
  await assertPdfDecompressionWithinBudget(buffer);

  // Page by page, stopping at the character budget, rather than extractText's
  // mergePages, which decoded every page before any cap could apply.
  const doc = await getDocumentProxy(buffer);
  let text: string;
  try {
    text = await collectPageText(doc);
  } finally {
    await doc.destroy();
  }

  if (!text || text.trim().length === 0) {
    throw new ChatbotError(
      "bad_request:api",
      "Could not extract text from this PDF. It may be image-based (scanned/designed). Please use a text-based PDF or paste the content as a URL instead."
    );
  }

  return text;
}
