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

/** Pages read from one PDF. Refused outright above this, before any page is parsed. */
export const MAX_PDF_PAGES = positiveIntFromEnv("RESEARCH_MAX_PDF_PAGES", 500);

/**
 * Whole multipart request body. The file itself is capped at MAX_SOURCE_BYTES;
 * this adds room for the boundaries and part headers around it.
 */
export const MAX_UPLOAD_BODY_BYTES = MAX_SOURCE_BYTES + 256 * 1024;

/** A JSON submission is one URL; nothing legitimate comes near this. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

function describeLimit(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

function tooLarge(maxBytes: number): ChatbotError {
  return new ChatbotError(
    "bad_request:api",
    `Source is larger than the ${describeLimit(maxBytes)} limit`
  );
}

/**
 * Read a stream, refusing to buffer more than `maxBytes`.
 *
 * A declared length is a claim by the other side, so it is used only as an
 * early rejection and never as the reason to stop reading: a sender that omits
 * it, or lies, still cannot push more than the cap through here, because the
 * running total is what ends the loop. Cancelling the reader stops the transfer
 * rather than leaving it running after the rejection — for a request body that
 * destroys the socket, so an oversized upload is not read to EOF.
 */
async function readCappedStream(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(declaredLength);
  if (declaredLength !== null && Number.isFinite(declared) && declared > maxBytes) {
    await body?.cancel().catch(() => {});
    throw tooLarge(maxBytes);
  }

  if (!body) {
    return new Uint8Array(0);
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
        throw tooLarge(maxBytes);
      }
      parts.push(value);
    }
  } finally {
    // Releasing an already-finished reader is harmless; cancelling a rejected
    // one is the point — otherwise the transfer keeps running after the throw.
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

/** Read a response body under the byte budget. */
export function readCappedBytes(
  response: Response,
  maxBytes: number = MAX_SOURCE_BYTES
): Promise<Uint8Array<ArrayBuffer>> {
  return readCappedStream(
    response.body,
    response.headers.get("content-length"),
    maxBytes
  );
}

/**
 * Read an incoming request body under a byte budget, before any parsing.
 *
 * `request.formData()` and `request.json()` buffer the whole body first, so a
 * size check on the parsed result always runs too late. Reading the raw stream
 * here is what lets an oversized upload be refused, and its socket closed,
 * after at most `maxBytes`.
 */
export function readCappedRequestBody(
  request: Request,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  return readCappedStream(
    request.body,
    request.headers.get("content-length"),
    maxBytes
  );
}

/**
 * Release a response body that is not going to be read.
 *
 * Throwing on `!response.ok` without this leaves the body streaming: a 500 with
 * an endless body never reaches the byte cap, because nothing reads it, and it
 * holds the socket open.
 */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
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

/** The part of a pdf.js document this needs; a fake one stands in for tests. */
export type PdfTextSource = {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>;
    cleanup?: () => void;
  }>;
};

/**
 * Collect a PDF's text one page at a time, stopping at the character budget.
 *
 * `extractText(..., { mergePages: true })` decoded every page in parallel and
 * joined the whole string before the character cap could look at it, so the cap
 * bounded what was *kept*, not what was *decoded*. Reading page by page lets
 * extraction stop as soon as the budget is spent, and an absurd page count is
 * refused before any page is parsed.
 *
 * This does not bound a single page's inflate: a one-page Flate bomb still
 * decompresses inside pdf.js when that page's content stream is decoded.
 */
export async function collectPageText(
  doc: PdfTextSource,
  maxChars: number = MAX_EXTRACTED_CHARS,
  maxPages: number = MAX_PDF_PAGES
): Promise<string> {
  if (doc.numPages > maxPages) {
    throw new ChatbotError(
      "bad_request:api",
      `PDF has ${doc.numPages} pages, over the ${maxPages}-page limit`
    );
  }

  const pieces: string[] = [];
  let length = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    page.cleanup?.();

    const text = content.items
      .map((item) =>
        item && typeof item === "object" && "str" in item
          ? String((item as { str: unknown }).str)
          : ""
      )
      .join(" ");

    pieces.push(text);
    length += text.length + 1;
    if (length >= maxChars) {
      break;
    }
  }

  const joined = pieces.join("\n");
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

type SourceLike = { type: string };

/**
 * Pick which sources one chat message may ingest.
 *
 * Attached files go first: the user uploaded them on purpose, while URLs are
 * scraped out of prose and may just be citations. Keeping the first N in
 * insertion order did the opposite — URLs are collected before file parts — so
 * five cited links silently pushed an attachment out. Everything not kept is
 * returned so the caller can tell the user rather than only logging it.
 */
export function selectSourcesWithinBudget<T extends SourceLike>(
  sources: T[],
  limit: number = MAX_SOURCES_PER_REQUEST
): { kept: T[]; dropped: T[] } {
  const ordered = [
    ...sources.filter((source) => source.type !== "url"),
    ...sources.filter((source) => source.type === "url"),
  ];
  return { kept: ordered.slice(0, limit), dropped: ordered.slice(limit) };
}
