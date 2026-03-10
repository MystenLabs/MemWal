import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import { chunkDocument } from "./chunking";
import { batchEmbed } from "./embeddings";
import { getLanguageModel } from "./providers";
import { createSource, createSourceChunks } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { extractText } from "unpdf";

export const JINA_READER_URL = "https://r.jina.ai/";
export const CHUNK_EXPIRY_DAYS = 7;
export const SUMMARY_MODEL = "google/gemini-2.5-flash";

export const summarySchema = z.object({
  title: z.string().describe("Document title or generated title"),
  summary: z
    .string()
    .describe("2-3 sentence summary of the document's main points"),
  claims: z
    .array(z.string())
    .describe("3-8 key claims or findings from the document"),
});

// --- Content extraction ---

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

// --- Metadata generation ---

export async function generateSourceMetadata(
  text: string
): Promise<z.infer<typeof summarySchema>> {
  const previewText = text.slice(0, 8000);

  const { object } = await generateObject({
    model: getLanguageModel(SUMMARY_MODEL),
    schema: summarySchema,
    prompt: `Analyze this document and provide a title, summary, and key claims.

---
${previewText}
---`,
  });

  return object;
}

// --- URL extraction ---

const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\.0\.0\.1/,
  /^https?:\/\/0\.0\.0\.0/,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
];

export function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/\S+/gi;
  const matches = text.match(urlRegex) || [];

  // Clean trailing punctuation that's likely not part of the URL
  const cleaned = matches.map((url) => url.replace(/[),;:!?\]}>'"]+$/, ""));

  // Filter private/local IPs and deduplicate
  const filtered = cleaned.filter(
    (url) => !PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(url))
  );

  return [...new Set(filtered)];
}

// --- Source input types ---

export type SourceInput =
  | { type: "url"; url: string }
  | { type: "pdf"; fileUrl: string; fileName: string }
  | { type: "pdf-file"; file: File };

// --- Main processing pipeline ---

export async function processSource({
  source,
  userId,
}: {
  source: SourceInput;
  userId: string;
}): Promise<{
  sourceId: string;
  title: string;
  chunkCount: number;
  type: "url" | "pdf";
  url?: string;
  summary: string;
  claims: string[];
  expiresAt: string;
  createdAt: string;
}> {
  let rawText: string;
  let originalUrl: string | undefined;
  let type: "url" | "pdf";

  if (source.type === "url") {
    type = "url";
    originalUrl = source.url;
    rawText = await extractFromUrl(source.url);
  } else if (source.type === "pdf-file") {
    type = "pdf";
    rawText = await extractFromPdf(source.file);
  } else {
    type = "pdf";
    // Download the PDF from the uploaded file URL
    const response = await fetch(source.fileUrl);
    if (!response.ok) {
      throw new ChatbotError(
        "bad_request:api",
        `Failed to download PDF: ${response.statusText}`
      );
    }
    const blob = await response.blob();
    const file = new File([blob], source.fileName, {
      type: "application/pdf",
    });
    rawText = await extractFromPdf(file);
  }

  // Run chunking and metadata generation in parallel
  const [metadata, chunks] = await Promise.all([
    generateSourceMetadata(rawText),
    chunkDocument(rawText, ""),
  ]);

  // Embed all chunks
  const chunkTexts = chunks.map((c) => `${c.section}\n\n${c.content}`);
  const embeddings = await batchEmbed(chunkTexts);

  // Create source record
  const expiresAt = new Date(
    Date.now() + CHUNK_EXPIRY_DAYS * 24 * 60 * 60 * 1000
  );

  const sourceRecord = await createSource({
    userId,
    type,
    title: metadata.title,
    url: originalUrl,
    summary: metadata.summary,
    claims: metadata.claims,
    chunkCount: chunks.length,
  });

  // Store chunks with embeddings
  if (chunks.length > 0) {
    await createSourceChunks({
      chunks: chunks.map((chunk, i) => ({
        sourceId: sourceRecord.id,
        section: chunk.section,
        content: chunk.content,
        embedding: embeddings[i],
        expiresAt,
      })),
    });
  }

  return {
    sourceId: sourceRecord.id,
    title: metadata.title,
    type,
    url: originalUrl,
    summary: metadata.summary,
    claims: metadata.claims,
    chunkCount: chunks.length,
    expiresAt: expiresAt.toISOString(),
    createdAt: sourceRecord.createdAt.toISOString(),
  };
}
