import "server-only";

import { chunkDocument, estimateTokens } from "./chunking";
import { batchEmbed } from "./embeddings";
import { extractFromUrl, extractFromPdf } from "./extract";
import { generateSourceMetadata } from "./metadata";
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

  console.log(`[ingest] Starting ingestion — type=${type}, text length=${rawText.length} chars`);

  // Run chunking and metadata generation in parallel
  const [metadata, chunks] = await Promise.all([
    generateSourceMetadata(rawText),
    chunkDocument(rawText, ""),
  ]);

  console.log(`[ingest] Chunking complete — ${chunks.length} chunks, title="${metadata.title}"`);

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
