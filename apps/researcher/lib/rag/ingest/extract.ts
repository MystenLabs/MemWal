import "server-only";

import { ChatbotError } from "@/lib/errors";
import { extractText } from "unpdf";

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

  const text = await response.text();
  if (!text || text.trim().length === 0) {
    throw new ChatbotError("bad_request:api", "Extracted content is empty");
  }

  return text;
}

export async function extractFromPdf(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
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
