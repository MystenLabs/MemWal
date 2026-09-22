import "server-only";

import { ChatbotError } from "@/lib/errors";
import { extractText } from "unpdf";

import {
  MAX_SOURCE_BYTES,
  assertLooksLikePdf,
  assertSourceFileWithinBudget,
  readCappedText,
} from "./limits";

export const JINA_READER_URL = "https://r.jina.ai/";

export async function extractFromUrl(url: string): Promise<string> {
  const response = await fetch(`${JINA_READER_URL}${url}`, {
    headers: { Accept: "text/markdown" },
  });

  if (!response.ok) {
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
  // Size is checked before `arrayBuffer()`, so an oversized upload is refused
  // rather than buffered and then refused. The magic-byte check after it is
  // what makes this a PDF check at all — the caller only ever saw a filename.
  const buffer = new Uint8Array(
    await assertSourceFileWithinBudget(file).arrayBuffer()
  );
  assertLooksLikePdf(buffer);
  const result = await extractText(buffer, { mergePages: true });

  const text = String(result.text);

  if (!text || text.trim().length === 0) {
    throw new ChatbotError(
      "bad_request:api",
      "Could not extract text from this PDF. It may be image-based (scanned/designed). Please use a text-based PDF or paste the content as a URL instead."
    );
  }

  return text;
}
