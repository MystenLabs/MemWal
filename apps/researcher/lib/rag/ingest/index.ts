import "server-only";

import { chunkDocument, estimateTokens } from "./chunking";
import { batchEmbed } from "./embeddings";
import { extractFromUrl, extractFromPdf } from "./extract";
import { generateSourceMetadata } from "./metadata";
import {
  MAX_CHUNKS_PER_SOURCE,
  capExtractedText,
  discardBody,
  readCappedBytes,
} from "./limits";
import { fetchPublicUrl } from "./safe-fetch";
import { createSource, createSourceChunks } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import type { SourceInput } from "@/lib/ai/source-processing";
import { CHUNK_TTL_MS } from "@/lib/rag/constants";

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
    // Download the PDF from the uploaded file URL. The URL arrives from the
    // request body, so the destination is checked before anything is sent.
    const response = await fetchPublicUrl(source.fileUrl);
    if (!response.ok) {
      await discardBody(response);
      throw new ChatbotError(
        "bad_request:api",
        `Failed to download PDF: ${response.statusText}`
      );
    }
    // Capped while streaming: a remote that omits or lies about Content-Length
    // still cannot push more than the budget into memory (WALM-683).
    const bytes = await readCappedBytes(response);
    const file = new File([bytes], source.fileName, {
      type: "application/pdf",
    });
    rawText = await extractFromPdf(file);
  }

  // One cap covering every branch above, because what follows — metadata
  // generation, chunking, and one embedding call per batch with no ceiling on
  // the batch count — all scale with this length.
  rawText = capExtractedText(rawText);

  console.log(`[ingest] Starting ingestion — type=${type}, text length=${rawText.length} chars`);

  // Run chunking and metadata generation in parallel
  const [metadata, chunks] = await Promise.all([
    generateSourceMetadata(rawText),
    chunkDocument(rawText, ""),
  ]);

  console.log(`[ingest] Chunking complete — ${chunks.length} chunks, title="${metadata.title}"`);

  // The character cap already bounds this, but chunk size varies with document
  // structure, so bound the embedding work directly too: `batchEmbed` limits a
  // batch to 100 entries and does not limit how many batches it runs.
  if (chunks.length > MAX_CHUNKS_PER_SOURCE) {
    throw new ChatbotError(
      "bad_request:api",
      `Source produced ${chunks.length} chunks, over the ${MAX_CHUNKS_PER_SOURCE} limit for one source. Split it into smaller documents.`
    );
  }

  // Embed all chunks
  const chunkTexts = chunks.map((c) => `${c.section}\n\n${c.content}`);
  const embeddings = await batchEmbed(chunkTexts);

  console.log(`[ingest] Embedding complete — ${embeddings.length} embeddings`);

  // Create source record
  const expiresAt = new Date(Date.now() + CHUNK_TTL_MS);

  const sourceRecord = await createSource({
    userId,
    type,
    title: metadata.title,
    url: originalUrl,
    summary: metadata.summary,
    claims: metadata.claims,
    chunkCount: chunks.length,
  });

  // Store chunks with embeddings, chunkIndex, tokenCount, and searchVector
  if (chunks.length > 0) {
    await createSourceChunks({
      chunks: chunks.map((chunk, i) => ({
        sourceId: sourceRecord.id,
        section: chunk.section,
        content: chunk.content,
        embedding: embeddings[i],
        chunkIndex: chunk.chunkIndex,
        tokenCount: estimateTokens(chunk.content),
        expiresAt,
      })),
    });
  }

  console.log(`[ingest] Stored source=${sourceRecord.id}, ${chunks.length} chunks with chunkIndex/tokenCount/searchVector`);

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
