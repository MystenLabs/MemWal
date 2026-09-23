import assert from "node:assert/strict";
import test from "node:test";
import { constants, createDeflate, deflateSync, inflateSync } from "node:zlib";

import { getDocumentProxy } from "unpdf";

import { ChatbotError } from "@/lib/errors";

import { collectPageText } from "./limits";
import {
  assertPdfDecompressionWithinBudget,
  type PdfGuardLimits,
} from "./pdf-guard";

// WALM-683 review follow-up on #985: a single-page Flate bomb inflated inside
// pdf.js before any cap could run. Nothing in this file lets pdf.js near a bomb:
// the guard has to refuse it first, and the tests only ever hand pdf.js files
// the guard has already accepted.

function causeMatches(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ChatbotError, `expected a ChatbotError, got ${error}`);
    assert.match(String(error.cause), pattern);
    return true;
  };
}

const MB = 1024 * 1024;
const SMALL: PdfGuardLimits = { perStream: 1 * MB, total: 4 * MB, streams: 100 };

type StreamSpec = { dict: string; data: Uint8Array };

/**
 * Build a PDF whose page content is `content` and which carries any `extra`
 * streams as further objects. Binary-safe, with a correct xref.
 */
function buildPdf(content: StreamSpec, extra: StreamSpec[] = [], trailerExtra = ""): Uint8Array {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: string | Uint8Array) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : Buffer.from(chunk);
    parts.push(buf);
    length += buf.length;
  };
  const object = (id: number, body: string | StreamSpec) => {
    offsets[id] = length;
    if (typeof body === "string") {
      push(`${id} 0 obj\n${body}\nendobj\n`);
    } else {
      push(`${id} 0 obj\n<<${body.dict}/Length ${body.data.length}>>\nstream\n`);
      push(body.data);
      push("\nendstream\nendobj\n");
    }
  };

  push("%PDF-1.4\n");
  object(1, "<</Type/Catalog/Pages 2 0 R>>");
  object(2, "<</Type/Pages/Kids[3 0 R]/Count 1>>");
  object(3, "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>");
  object(4, content);
  object(5, "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>");
  let id = 6;
  for (const spec of extra) {
    object(id++, spec);
  }

  const xref = length;
  push(`xref\n0 ${id}\n0000000000 65535 f \n`);
  for (let i = 1; i < id; i++) {
    push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<</Size ${id}/Root 1 0 R${trailerExtra}>>\nstartxref\n${xref}\n%%EOF`);
  return new Uint8Array(Buffer.concat(parts));
}

/** Deflate `total` zero bytes without ever allocating them in one piece. */
async function deflateZeros(total: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise((resolve) => deflate.on("end", resolve));
  const zeros = Buffer.alloc(MB);
  for (let written = 0; written < total; written += MB) {
    if (!deflate.write(zeros)) {
      await new Promise((resolve) => deflate.once("drain", resolve));
    }
  }
  deflate.end();
  await done;
  return Buffer.concat(chunks);
}

const TEXT = "BT /F1 12 Tf 10 100 Td (Hello from a compressed page) Tj ET";

function flate(bytes: Uint8Array | string): StreamSpec {
  return {
    dict: "/Filter/FlateDecode",
    data: deflateSync(typeof bytes === "string" ? Buffer.from(bytes) : bytes),
  };
}

// ── what must still work ──────────────────────────────────────────────────

test("an ordinary Flate-compressed PDF passes and still extracts through pdf.js", async () => {
  const pdf = buildPdf(flate(TEXT));

  await assertPdfDecompressionWithinBudget(pdf, SMALL);

  const doc = await getDocumentProxy(pdf);
  try {
    assert.match(await collectPageText(doc), /Hello from a compressed page/);
  } finally {
    await doc.destroy();
  }
});

test("an uncompressed PDF passes without inflating anything", async () => {
  await assertPdfDecompressionWithinBudget(
    buildPdf({ dict: "", data: Buffer.from(TEXT) }),
    SMALL
  );
});

test("image codecs are not inflated and do not count against the budget", async () => {
  // pdf.js does not decode images to extract text, and DCT/JPX/CCITT/JBIG2 do
  // not have a Flate-style ratio anyway.
  const jpeg = { dict: "/Subtype/Image/Filter/DCTDecode", data: new Uint8Array(3 * MB) };
  await assertPdfDecompressionWithinBudget(buildPdf(flate(TEXT), [jpeg]), SMALL);
});

// ── bombs ─────────────────────────────────────────────────────────────────

test("a Flate bomb is refused before pdf.js sees it, at the default budget", async () => {
  // 256MB of zeros compresses to about a quarter megabyte — nothing any upload cap
  // would notice — and is four times the default 64MB per-stream budget. Built
  // from 1MB chunks so the test never holds 256MB itself; allocating it in one
  // piece put a garbage-collection pause inside the timed window below.
  const bomb = { dict: "/Filter/FlateDecode", data: await deflateZeros(256 * MB) };
  assert.ok(bomb.data.length < 1 * MB, "the bomb must be small on disk");
  const pdf = buildPdf(bomb);

  const started = performance.now();
  await assert.rejects(
    () => assertPdfDecompressionWithinBudget(pdf),
    causeMatches(/expands too far/)
  );
  const elapsed = performance.now() - started;
  assert.ok(
    elapsed < 500,
    `measuring took ${elapsed.toFixed(0)}ms; it must stop at the cap, not inflate 256MB`
  );
});

test("a bomb hidden behind a fake endstream inside its own data is still measured", async () => {
  // The first deflate block is *stored*, so its bytes appear verbatim in the
  // file — including a literal "endstream". A scan that trusts the keyword (or
  // a forged /Length) would inflate only that harmless prefix. The guard reads
  // to where the deflate data really ends.
  const deflate = createDeflate({ level: 0 });
  const chunks: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise((resolve) => deflate.on("end", resolve));

  deflate.write(Buffer.from("\nendstream\nendobj\n"));
  await new Promise<void>((resolve) => deflate.flush(constants.Z_FULL_FLUSH, () => resolve()));
  await new Promise<void>((resolve) =>
    deflate.params(9, constants.Z_DEFAULT_STRATEGY, () => resolve())
  );
  deflate.end(new Uint8Array(64 * MB));
  await done;

  const data = Buffer.concat(chunks);
  const fakeEnd = data.indexOf("endstream");
  assert.ok(fakeEnd >= 0 && fakeEnd < 64, "the fake keyword must sit at the start of the data");
  // What a boundary-trusting scan would have measured: the prefix up to the
  // fake keyword, which inflates to a few bytes and would have passed.
  const prefix = inflateSync(data.subarray(0, fakeEnd), {
    finishFlush: constants.Z_SYNC_FLUSH,
  });
  assert.ok(prefix.length < 64, `the prefix alone inflates to ${prefix.length} bytes`);

  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf({ dict: "/Filter/FlateDecode", data }),
        SMALL
      ),
    causeMatches(/expands too far/)
  );
});

test("streams that are each under budget are refused when they add up past the total", async () => {
  const each = flate(new Uint8Array(900 * 1024)); // under the 1MB per-stream cap
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf(flate(TEXT), [each, each, each, each, each]),
        SMALL
      ),
    causeMatches(/in total/)
  );
});

test("a RunLength bomb is refused without decoding it", async () => {
  // Each 2-byte run (length byte 129) repeats one byte 128 times: 64:1.
  const runs = new Uint8Array(64 * 1024);
  for (let i = 0; i < runs.length; i += 2) {
    runs[i] = 129;
  }
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf({ dict: "/Filter/RunLengthDecode", data: runs }),
        SMALL
      ),
    causeMatches(/expands too far/)
  );
});

// ── what it cannot bound, so it refuses ───────────────────────────────────

test("Flate behind another filter is refused", async () => {
  // ASCII85 first means the raw bytes are not zlib: nothing would be measured,
  // and pdf.js would decode the ASCII85 and then inflate whatever it hides.
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf({ dict: "/Filter[/ASCII85Decode/FlateDecode]", data: Buffer.from("<~~>") }),
        SMALL
      ),
    causeMatches(/cannot check/)
  );
});

test("LZW is refused", async () => {
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf({ dict: "/Filter/LZWDecode", data: new Uint8Array(8) }),
        SMALL
      ),
    causeMatches(/does not accept/)
  );
});

test("a filter given by indirect reference is refused", async () => {
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf({ dict: "/Filter 9 0 R", data: new Uint8Array(8) }),
        SMALL
      ),
    causeMatches(/cannot check/)
  );
});

test("an encrypted PDF is refused, since its streams cannot be measured", async () => {
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf(flate(TEXT), [], "/Encrypt 9 0 R"),
        SMALL
      ),
    causeMatches(/Encrypted/)
  );
});

test("a file of more streams than the limit is refused before measuring them", async () => {
  const tiny = flate("x");
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf(flate(TEXT), Array.from({ length: 5 }, () => tiny)),
        { ...SMALL, streams: 3 }
      ),
    causeMatches(/streams, over/)
  );
});

// ── ways around a stricter-than-pdf.js scan ───────────────────────────────

const BOMB = deflateSync(new Uint8Array(16 * MB));

test("an escaped filter name is decoded before it is judged", async () => {
  // /Flat#65Decode is /FlateDecode to pdf.js. Matched on its raw spelling it
  // would look like an unknown filter and go unmeasured.
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf({ dict: "/Filter/Flat#65Decode", data: BOMB }),
        SMALL
      ),
    causeMatches(/expands too far/)
  );
});

test("an unknown filter name is refused rather than let through unmeasured", async () => {
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf({ dict: "/Filter/SomethingElse", data: new Uint8Array(8) }),
        SMALL
      ),
    causeMatches(/cannot check/)
  );
});

/** Rewrite the content stream's `>>\nstream\n` separator as `separator`. */
function withSeparator(pdf: Uint8Array, separator: string): Uint8Array {
  const text = Buffer.from(pdf).toString("latin1");
  const at = text.indexOf(">>\nstream\n");
  assert.ok(at >= 0);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(pdf.subarray(0, at)),
      Buffer.from(separator, "latin1"),
      Buffer.from(pdf.subarray(at + ">>\nstream\n".length)),
    ])
  );
}

for (const [label, separator] of [
  ["a comment between the dictionary and the keyword", ">> % harmless\nstream\n"],
  ["trailing junk after the keyword", ">>\nstream   \n"],
  ["a CR-only line ending", ">>\rstream\r"],
] as const) {
  test(`a bomb separated by ${label} is still found`, async () => {
    const pdf = withSeparator(
      buildPdf({ dict: "/Filter/FlateDecode", data: BOMB }),
      separator
    );
    await assert.rejects(
      () => assertPdfDecompressionWithinBudget(pdf, SMALL),
      causeMatches(/expands too far/)
    );
  });
}
