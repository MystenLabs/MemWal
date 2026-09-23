import { createInflate, constants as zlibConstants } from "node:zlib";

import { ChatbotError } from "@/lib/errors";

/**
 * Decompression-bomb guard for uploaded PDFs (WALM-683).
 *
 * A PDF stores page content, fonts and object streams Flate-compressed, and
 * deflate reaches about 1030:1 — so a 1MB upload can hold a stream that
 * decompresses to a gigabyte. pdf.js inflates a stream in full, doubling its
 * buffer with no ceiling, before handing back a single character, so none of
 * the byte, page or character caps downstream ever sees it: one upload takes the
 * replica down with every request on it.
 *
 * JavaScript cannot put a memory ceiling around pdf.js, so this measures instead.
 * Before pdf.js sees the file, every compressed stream is inflated here with the
 * output *counted and discarded*, never kept, and the file is refused if any
 * stream, or all of them together, would expand past the budget. Counting a 1GB
 * bomb up to a 64MB cap takes tens of milliseconds and a few MB of memory.
 *
 * The rules are conservative on purpose: anything this cannot bound is refused,
 * because anything it lets through unmeasured is something pdf.js will inflate.
 *
 *   - Each stream is measured from its first byte to wherever the deflate data
 *     itself ends. `/Length` and the `endstream` keyword are the file's claims,
 *     and a bomb can plant a fake `endstream` inside its own data to make a
 *     boundary-trusting scan see only a harmless prefix.
 *   - Flate and RunLength expand, so they are only accepted as a stream's *first*
 *     filter, where the raw bytes are what they decode. Behind another filter
 *     (ASCII85 then Flate, say) the raw bytes are not zlib, this scan would
 *     measure nothing, and pdf.js would still inflate the result.
 *   - LZW is refused outright, as is a `/Filter` given by indirect reference:
 *     neither can be bounded without decoding or resolving it.
 *   - Encrypted files are refused. Their stream bytes are ciphertext, so nothing
 *     here can be measured, while pdf.js decrypts (with an empty password) and
 *     then inflates.
 *
 * The thresholds are the team's call; the defaults are generous for real
 * documents — text content is kilobytes to a few MB per stream — and can be
 * changed per environment without a deploy.
 */

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Largest decompressed size accepted for any single stream. */
export const MAX_INFLATED_BYTES_PER_STREAM = positiveIntFromEnv(
  "RESEARCH_PDF_MAX_INFLATED_BYTES_PER_STREAM",
  64 * 1024 * 1024
);

/** Largest decompressed size accepted across every stream in the file. */
export const MAX_INFLATED_BYTES_TOTAL = positiveIntFromEnv(
  "RESEARCH_PDF_MAX_INFLATED_BYTES_TOTAL",
  256 * 1024 * 1024
);

/** Streams in one file. Bounds the scan's own work on a file of tiny streams. */
export const MAX_PDF_STREAMS = positiveIntFromEnv(
  "RESEARCH_PDF_MAX_STREAMS",
  20_000
);

export type PdfGuardLimits = {
  perStream: number;
  total: number;
  streams: number;
};

const DEFAULT_LIMITS: PdfGuardLimits = {
  perStream: MAX_INFLATED_BYTES_PER_STREAM,
  total: MAX_INFLATED_BYTES_TOTAL,
  streams: MAX_PDF_STREAMS,
};

function refuse(reason: string): ChatbotError {
  return new ChatbotError("bad_request:api", reason);
}

const FLATE = new Set(["FlateDecode", "Fl"]);
const RUN_LENGTH = new Set(["RunLengthDecode", "RL"]);
const REFUSED = new Set(["LZWDecode", "LZW", "Crypt"]);

/**
 * Filters that do not expand meaningfully, and that pdf.js does not decode to
 * extract text. Anything *not* on this list and not handled above is refused:
 * an unrecognised name is one this scan cannot reason about, so letting it
 * through unmeasured would be a way around the guard.
 */
const PASSIVE = new Set([
  "ASCIIHexDecode",
  "AHx",
  "ASCII85Decode",
  "A85",
  "DCTDecode",
  "DCT",
  "JPXDecode",
  "CCITTFaxDecode",
  "CCF",
  "JBIG2Decode",
]);

/**
 * PDF names may escape any byte as `#xx`, and pdf.js decodes them: `/Flat#65Decode`
 * is `/FlateDecode`. Matching the raw spelling would let an escaped Flate filter
 * pass as an unknown one.
 */
function decodeName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

/** Latin-1 view of the bytes, so byte offsets and string indexes line up. */
function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "latin1"
  );
}

type StreamStart = { dataStart: number; filters: string[] | "indirect" };

/**
 * Every place a stream's data begins, with the filters its dictionary declares.
 *
 * Streams may only appear as top-level objects — never inside an object stream —
 * so every one of them is visible in the raw file as `>> stream<EOL>`. The
 * dictionary is the text between the preceding `obj` keyword and the keyword.
 */
function findStreams(text: string): StreamStart[] {
  const starts: StreamStart[] = [];
  // Whitespace and comments may sit between the dictionary and the keyword, and
  // pdf.js skips to the next line after `stream` rather than requiring the line
  // break immediately — so a scan stricter than pdf.js would miss streams that
  // pdf.js still reads.
  const keyword = />>(?:\s|%[^\r\n]*)*stream[^\r\n]*(\r\n|\n|\r)/g;

  for (let match = keyword.exec(text); match; match = keyword.exec(text)) {
    const dataStart = match.index + match[0].length;
    const objAt = text.lastIndexOf("obj", match.index);
    const dict = text.slice(objAt === -1 ? 0 : objAt, match.index + 2);

    const filter = /\/Filter\s*(\[[^\]]*\]|\/[^\s/<>[\]()]+|\d+\s+\d+\s+R)/.exec(
      dict
    );
    let filters: string[] | "indirect" = [];
    if (filter) {
      filters = /R$/.test(filter[1].trim())
        ? "indirect"
        : Array.from(filter[1].matchAll(/\/([^\s/<>[\]()]+)/g), (m) =>
            decodeName(m[1])
          );
    }
    starts.push({ dataStart, filters });
  }

  return starts;
}

/**
 * How many bytes a zlib stream starting at `data` expands to, counted and
 * discarded, stopping as soon as `limit` is passed. Input runs to the end of the
 * file on purpose: deflate marks its own end, so zlib stops where the data
 * really stops, whatever the file claims about the boundary.
 */
function inflatedSize(
  data: Uint8Array,
  limit: number
): Promise<{ size: number; exceeded: boolean }> {
  return new Promise((resolve) => {
    const inflate = createInflate({
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
    });
    let size = 0;
    let settled = false;
    const finish = (exceeded: boolean) => {
      if (!settled) {
        settled = true;
        resolve({ size, exceeded });
      }
    };

    inflate.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        inflate.destroy();
        finish(true);
      }
    });
    inflate.on("end", () => finish(false));
    // A corrupt or non-zlib stream stops where pdf.js's own inflater would stop
    // too; what was produced before the error is what it could have produced.
    inflate.on("error", () => finish(false));
    inflate.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  });
}

/**
 * RunLengthDecode output size, computed from the length bytes without decoding.
 * It is the other expanding filter: a 2-byte run repeats one byte 128 times.
 */
function runLengthSize(data: Uint8Array, limit: number): number {
  let size = 0;
  let i = 0;
  while (i < data.length && size <= limit) {
    const length = data[i];
    if (length === 128) {
      break; // end of data
    }
    if (length < 128) {
      size += length + 1;
      i += length + 2;
    } else {
      size += 257 - length;
      i += 2;
    }
  }
  return size;
}

/**
 * Refuse a PDF whose streams would decompress past the budget, before pdf.js
 * inflates any of them. Returns quietly when the file is within budget.
 */
export async function assertPdfDecompressionWithinBudget(
  bytes: Uint8Array,
  limits: PdfGuardLimits = DEFAULT_LIMITS
): Promise<void> {
  const text = latin1(bytes);

  if (/\/Encrypt\b/.test(text)) {
    throw refuse(
      "Encrypted PDFs cannot be processed. Remove the protection and upload it again."
    );
  }

  const streams = findStreams(text);
  if (streams.length > limits.streams) {
    throw refuse(
      `PDF has ${streams.length} streams, over the ${limits.streams} limit`
    );
  }

  let total = 0;

  for (const { dataStart, filters } of streams) {
    if (filters === "indirect") {
      throw refuse("PDF uses a stream filter this service cannot check");
    }
    if (filters.some((name) => REFUSED.has(name))) {
      throw refuse("PDF uses a compression format this service does not accept");
    }

    const expanding = filters.findIndex(
      (name) => FLATE.has(name) || RUN_LENGTH.has(name)
    );
    const unknown = filters.find(
      (name) => !FLATE.has(name) && !RUN_LENGTH.has(name) && !PASSIVE.has(name)
    );
    if (unknown !== undefined) {
      throw refuse("PDF uses a stream filter this service cannot check");
    }
    if (expanding === -1) {
      continue; // raw, or only filters that do not expand meaningfully
    }
    if (expanding !== 0) {
      throw refuse("PDF uses a stream filter this service cannot check");
    }

    const data = bytes.subarray(dataStart);
    const remaining = limits.total - total;
    const budget = Math.min(limits.perStream, remaining);

    const size = FLATE.has(filters[0])
      ? (await inflatedSize(data, budget)).size
      : runLengthSize(data, budget);

    if (size > limits.perStream) {
      throw refuse(
        "PDF contains a compressed stream that expands too far to process safely"
      );
    }
    total += size;
    if (total > limits.total) {
      throw refuse("PDF expands too far in total to process safely");
    }
  }
}
