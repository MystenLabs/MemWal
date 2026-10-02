import "server-only";

import { chunkDocument, estimateTokens } from "./chunking";
import { batchEmbed } from "./embeddings";
import { extractFromUrl, extractFromPdf } from "./extract";
import { generateSourceMetadata } from "./metadata";
import {
  MAX_CHUNKS_PER_SOURCE,
  capExtractedText,
  discardBody,
  OUT_OF_TIME_REASON,
  readCappedBytes,
  timeLeft,
} from "./limits";
import { fetchPublicUrl } from "./safe-fetch";
import { createSource, createSourceChunks } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import type { SourceInput } from "@/lib/ai/source-processing";
import { CHUNK_TTL_MS } from "@/lib/rag/constants";

function ranOutOfTime(): ChatbotError {
  return new ChatbotError("bad_request:api", OUT_OF_TIME_REASON);
}

export async function processSource({
  source,
  userId,
  deadlineAt,
}: {
  source: SourceInput;
  userId: string;
  /**
   * When extraction has to be done (epoch ms), from the caller's own time
   * budget. Downloads are aborted and PDF reading stops at this point; omit it
   * to rely on the per-source limits alone (WALM-683).
   */
  deadlineAt?: number;
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

  const left = timeLeft(deadlineAt);
  if (left <= 0) {
    throw ranOutOfTime();
  }
  // Everything that waits on the network (Jina, the PDF download, and the
  // model calls for metadata, chunking and embeddings) ends at the deadline
  // too. Chunking a long document is several model calls in a row, so a
  // source started near the deadline could otherwise run well past it.
  // setTimeout, which AbortSignal.timeout uses, fires at once past 2^31-1 ms.
  const signal = Number.isFinite(left)
    ? AbortSignal.timeout(Math.min(left, 2 ** 31 - 1))
    : undefined;
  // Read the clock rather than the signal: the PDF reader's own timers end at
  // the same instant and can fire first, and their message ("too many PDFs",
  // "took too long") would misdescribe a source that simply ran out of time.
  const outOfTime = () => timeLeft(deadlineAt) <= 0;
  const orOutOfTime = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      if (outOfTime()) {
        throw ranOutOfTime();
      }
      throw error;
    }
  };

  try {
    if (source.type === "url") {
      type = "url";
      originalUrl = source.url;
      rawText = await extractFromUrl(source.url, { signal });
    } else if (source.type === "pdf-file") {
      type = "pdf";
      rawText = await extractFromPdf(source.file, { deadlineAt });
    } else {
      type = "pdf";
      // Download the PDF from the uploaded file URL. The URL arrives from the
      // request body, so the destination is checked before anything is sent.
      const response = await fetchPublicUrl(source.fileUrl, { signal });
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
      rawText = await extractFromPdf(file, { deadlineAt });
    }
  } catch (error) {
    // An abort surfaces as a DOMException or a socket error; say what happened.
    if (outOfTime()) {
      throw ranOutOfTime();
    }
    throw error;
  }

  // One cap covering every branch above, because what follows — metadata
  // generation, chunking, and one embedding call per batch with no ceiling on
  // the batch count — all scale with this length.
  rawText = capExtractedText(rawText);

  console.log(`[ingest] Starting ingestion — type=${type}, text length=${rawText.length} chars`);

  // Run chunking and metadata generation in parallel
  const [metadata, chunks] = await orOutOfTime(
    Promise.all([
      generateSourceMetadata(rawText, { abortSignal: signal }),
      chunkDocument(rawText, "", { abortSignal: signal }),
    ])
  );

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
  const embeddings = await orOutOfTime(
    batchEmbed(chunkTexts, { abortSignal: signal })
  );

  // Nothing is stored for a source that ran out of time: better reported as
  // not processed than saved half-done.
  if (outOfTime()) {
    throw ranOutOfTime();
  }

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
