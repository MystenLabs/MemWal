import { ChatbotError } from "@/lib/errors";

/**
 * Ingestion budget (WALM-683).
 *
 * `processSource` turns one request into PDF parsing, LLM metadata generation,
 * chunking, an unbounded number of embedding batches, and database writes. None
 * of that was bounded: the PDF branch checked a filename suffix and no size, the
 * URL branch buffered whatever Jina returned, and `batchEmbed` capped the size
 * of a batch but not how many batches it ran. `maxDuration` is a timeout, not a
 * spend limit — work already started keeps costing until it is cut off.
 *
 * These caps live here rather than in the route so every caller inherits them.
 * The chat path and the direct `POST /api/research/process-source` route both
 * reach ingestion through `processSource`, and a budget only on the route would
 * leave the chat path unbudgeted.
 *
 * The numbers are deliberately generous for real documents and hostile to bulk
 * abuse: a 250-page text PDF sits far inside them. Tune with the env overrides
 * rather than by editing callers.
 */

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Bytes accepted for an uploaded or downloaded source, before any parsing. */
export const MAX_SOURCE_BYTES = positiveIntFromEnv(
  "RESEARCH_MAX_SOURCE_BYTES",
  20 * 1024 * 1024
);

/** Characters kept from an extracted document, before chunking or model calls. */
export const MAX_EXTRACTED_CHARS = positiveIntFromEnv(
  "RESEARCH_MAX_EXTRACTED_CHARS",
  1_000_000
);

/** Chunks embedded and stored for one source. */
export const MAX_CHUNKS_PER_SOURCE = positiveIntFromEnv(
  "RESEARCH_MAX_CHUNKS_PER_SOURCE",
  600
);

/** Sources accepted from a single chat message. */
export const MAX_SOURCES_PER_REQUEST = positiveIntFromEnv(
  "RESEARCH_MAX_SOURCES_PER_REQUEST",
  5
);

function describeLimit(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

/**
 * Read a response body, refusing to buffer more than `maxBytes`.
 *
 * Content-Length is a claim by the remote side, so it is used only as an early
 * rejection and never as the reason to stop reading: a server that omits it, or
 * lies, still cannot push more than the cap through here, because the running
 * total is what ends the loop. Cancelling the reader stops the transfer rather
 * than leaving it running after the rejection.
 */
export async function readCappedBytes(
  response: Response,
  maxBytes: number = MAX_SOURCE_BYTES
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ChatbotError(
      "bad_request:api",
      `Source is larger than the ${describeLimit(maxBytes)} limit`
    );
  }

  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ChatbotError(
        "bad_request:api",
        `Source is larger than the ${describeLimit(maxBytes)} limit`
      );
    }
    return buffer;
  }

  const reader = body.getReader();
  const parts: Uint8Array<ArrayBufferLike>[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ChatbotError(
          "bad_request:api",
          `Source is larger than the ${describeLimit(maxBytes)} limit`
        );
      }
      parts.push(value);
    }
  } finally {
    // Releasing an already-finished reader is harmless; cancelling a rejected
    // one is the point — otherwise the download keeps running after the throw.
    await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

/** Read a response as text, under the same byte cap as a binary source. */
export async function readCappedText(
  response: Response,
  maxBytes: number = MAX_SOURCE_BYTES
): Promise<string> {
  const bytes = await readCappedBytes(response, maxBytes);
  return new TextDecoder().decode(bytes);
}

/**
 * Reject an oversized upload before it is buffered into memory and parsed.
 *
 * The multipart value is checked for being a real `File` here too: the route
 * used `formData.get("file") as File`, and a cast is not a check — a plain text
 * field would reach `.name` as `undefined` and fail somewhere less obvious.
 */
export function assertSourceFileWithinBudget(
  value: FormDataEntryValue | null
): File {
  if (!(value instanceof File)) {
    throw new ChatbotError("bad_request:api", "Expected a PDF file upload");
  }

  if (value.size > MAX_SOURCE_BYTES) {
    throw new ChatbotError(
      "bad_request:api",
      `PDF is larger than the ${describeLimit(MAX_SOURCE_BYTES)} limit`
    );
  }

  return value;
}

/** `%PDF-`. A filename suffix says nothing about what the bytes are. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

export function assertLooksLikePdf(bytes: Uint8Array): void {
  const header = bytes.subarray(0, PDF_MAGIC.length);
  if (
    header.length < PDF_MAGIC.length ||
    !PDF_MAGIC.every((byte, index) => header[index] === byte)
  ) {
    throw new ChatbotError(
      "bad_request:api",
      "That file is not a PDF. Upload a PDF, or submit the source as a URL."
    );
  }
}

/**
 * Cap extracted text before it reaches metadata generation, chunking, and
 * embedding — the three places where length turns directly into model spend.
 */
export function capExtractedText(text: string): string {
  return text.length > MAX_EXTRACTED_CHARS
    ? text.slice(0, MAX_EXTRACTED_CHARS)
    : text;
}
