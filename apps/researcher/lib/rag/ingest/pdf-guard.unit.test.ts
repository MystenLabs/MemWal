import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  constants,
  createDeflate,
  deflateRawSync,
  deflateSync,
  inflateRawSync,
  inflateSync,
} from "node:zlib";

import { getDocumentProxy } from "unpdf";

import { ChatbotError } from "@/lib/errors";

import { collectPageText } from "./limits";
import {
  __test,
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
function buildPdf(
  content: StreamSpec,
  extra: StreamSpec[] = [],
  trailerExtra = "",
  rawBeforeXref: Uint8Array = new Uint8Array(0)
): Uint8Array {
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

  push(rawBeforeXref);
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

  // Refused either way: the tokeniser resumes after the first `endstream`, finds
  // the rest of the bomb where structure should be, and refuses it; were it to
  // get that far, measuring runs to the real end of the deflate data.
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf({ dict: "/Filter/FlateDecode", data }),
        SMALL
      ),
    causeMatches(/expands too far|cannot check/)
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

/** ASCII85-encode `bytes` the standard way, with `z` for zero groups. */
function ascii85(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = [0, 1, 2, 3].map((k) => bytes[i + k] ?? 0);
    const count = Math.min(4, bytes.length - i);
    let value = ((chunk[0] << 24) >>> 0) + (chunk[1] << 16) + (chunk[2] << 8) + chunk[3];
    if (value === 0 && count === 4) {
      out += "z";
      continue;
    }
    const digits: string[] = [];
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode((value % 85) + 33));
      value = Math.floor(value / 85);
    }
    out += digits.slice(0, count + 1).join("");
  }
  return `${out}~>`;
}

test("a bomb wrapped in ASCII85 or hex is decoded and still measured", async () => {
  // Older producers hex- or ASCII85-encode compressed data; pdf.js decodes that
  // stage first and then inflates. Refusing the chain rejected real files, so
  // the text stage is decoded here the way pdf.js does and the Flate measured.
  const bomb = deflateSync(new Uint8Array(16 * MB));
  for (const [dict, data] of [
    ["/Filter[/ASCII85Decode/FlateDecode]", Buffer.from(ascii85(bomb), "latin1")],
    ["/Filter[/ASCIIHexDecode/FlateDecode]", Buffer.from(`${bomb.toString("hex")}>`, "latin1")],
  ] as const) {
    await refusesAsBomb(buildPdf({ dict, data }));
  }
});

test("an ASCII85 + Flate page still extracts through pdf.js", async () => {
  const pdf = buildPdf({
    dict: "/Filter[/ASCII85Decode/FlateDecode]",
    data: Buffer.from(ascii85(deflateSync(Buffer.from(TEXT))), "latin1"),
  });
  await assertPdfDecompressionWithinBudget(pdf, SMALL);
  const doc = await getDocumentProxy(pdf.slice());
  try {
    assert.match(await collectPageText(doc), /Hello from a compressed page/);
  } finally {
    await doc.destroy();
  }
});

test("ASCII85's own 4:1 expansion counts against the budget", async () => {
  // `z` is four zero bytes: 1MB of it is 4MB decoded, with nothing compressed.
  await refusesAsBomb(
    buildPdf({ dict: "/Filter/ASCII85Decode", data: Buffer.from(`${"z".repeat(MB)}~>`, "latin1") })
  );
});

test("Flate behind a filter that is not a text stage is refused", async () => {
  // Behind an image codec the raw bytes are not zlib, nothing would be measured,
  // and pdf.js would still inflate whatever the first stage produced.
  for (const filters of ["[/DCTDecode/FlateDecode]", "[/FlateDecode/ASCII85Decode]"]) {
    await assert.rejects(
      () =>
        assertPdfDecompressionWithinBudget(
          buildPdf({ dict: `/Filter${filters}`, data: new Uint8Array(8) }),
          SMALL
        ),
      causeMatches(/cannot check/),
      filters
    );
  }
});

test("pathological whitespace, NUL and % runs do not stall the guard", async () => {
  // The raw scans used to be regular expressions that backtracked
  // exponentially on these; a real 395KB file hung the guard indefinitely.
  const nasty = Buffer.concat([
    Buffer.from(">>" + "%".repeat(50_000), "latin1"),
    Buffer.from("1 %".repeat(20_000) + "\n", "latin1"),
    Buffer.alloc(200_000, 0x00),
    Buffer.from(("7 \x00\x0b% " + "\xa0".repeat(40) + "\n").repeat(20_000), "latin1"),
  ]);
  const started = performance.now();
  await assertPdfDecompressionWithinBudget(buildPdf({ dict: "", data: nasty }), SMALL).catch(() => {});
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)}ms`);
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

test("an unknown filter name is let through, as pdf.js leaves it undecoded", async () => {
  // pdf.js's makeFilter returns the stream as-is for a name it does not know,
  // so an unknown filter cannot expand. Names are #xx-decoded first, so an
  // escaped Flate is not "unknown" (see the escaped-name test).
  await assertPdfDecompressionWithinBudget(
    buildPdf({ dict: "/Filter/SomethingElse", data: BOMB }),
    SMALL
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

// ── round 3 on #985: read every stream the way pdf.js reads it ───────────

async function refusesAsBomb(pdf: Uint8Array, limits = SMALL) {
  await assert.rejects(
    () => assertPdfDecompressionWithinBudget(pdf, limits),
    causeMatches(/expands too far/)
  );
}

for (const [label, dict] of [
  ["/F as the filter key", "/F/FlateDecode"],
  ["an escaped key, /#46ilter", "/#46ilter/FlateDecode"],
  ["an escaped /F, /#46", "/#46/FlateDecode"],
  ["/F winning over a passive /Filter", "/Filter/DCTDecode/F/FlateDecode"],
  ["a decoy /Filter inside a string", "/Title (/Filter /DCTDecode) /Filter/FlateDecode"],
  ["a decoy /Filter inside a comment", "% /Filter /DCTDecode\n/Filter/FlateDecode"],
  ["a repeated key, last one Flate", "/Filter/DCTDecode/Filter/FlateDecode"],
] as const) {
  test(`a bomb behind ${label} is measured`, async () => {
    // pdf.js: dict.get("F", "Filter"), names #xx-decoded by the lexer, strings
    // and comments are not keys, and Dict.set keeps a repeated key's last value.
    await refusesAsBomb(buildPdf({ dict, data: BOMB }));
  });
}

test("a repeated key whose last value is passive is not inflated", async () => {
  // The mirror image of the case above: pdf.js keeps the last value, DCT, and
  // never inflates this. Reading it as pdf.js does, not refusing, is the fix
  // for real pdfTeX output that repeats /Group.
  await assertPdfDecompressionWithinBudget(
    buildPdf({ dict: "/Filter/FlateDecode/Filter/DCTDecode", data: BOMB }),
    SMALL
  );
});

test("an escaped /Encrypt key is still encryption", async () => {
  await assert.rejects(
    () =>
      assertPdfDecompressionWithinBudget(
        buildPdf(flate(TEXT), [], "/#45ncrypt 9 0 R"),
        SMALL
      ),
    causeMatches(/Encrypted/)
  );
});

for (const filters of ["[/RunLengthDecode/FlateDecode]", "[/FlateDecode/RunLengthDecode]"]) {
  test(`two expanding filters, ${filters}, are refused`, async () => {
    // pdf.js runs the whole array; measuring only the first stage missed the
    // second one's output.
    await assert.rejects(
      () =>
        assertPdfDecompressionWithinBudget(
          buildPdf({ dict: `/Filter${filters}`, data: new Uint8Array(64) }),
          SMALL
        ),
      causeMatches(/cannot check/)
    );
  });
}

/** A zlib header with the given CMF byte and a valid FCHECK, FDICT clear. */
function zlibWithCmf(cmf: number, raw: Uint8Array): Uint8Array {
  for (let flg = 0; flg < 256; flg++) {
    if ((cmf * 256 + flg) % 31 === 0 && (flg & 0x20) === 0) {
      return new Uint8Array(Buffer.concat([Buffer.from([cmf, flg]), raw]));
    }
  }
  throw new Error("no valid FLG");
}

for (const cmf of [0x88, 0xf8]) {
  test(`a bomb with CINFO ${cmf >> 4} in its zlib header is still measured`, async () => {
    // pdf.js never checks CINFO; Node's zlib rejects a window over 32K, which
    // used to read as "0 bytes, fine". Inflating raw from byte 2 measures it.
    const data = zlibWithCmf(cmf, deflateRawSync(new Uint8Array(16 * MB)));
    await refusesAsBomb(buildPdf({ dict: "/Filter/FlateDecode", data }));
  });
}

test("a CINFO 15 content stream is measured, and pdf.js does read it", async () => {
  const content = "BT /F1 12 Tf 10 100 Td (GUARDPROBE) Tj ET";
  const pdf = buildPdf({
    dict: "/Filter/FlateDecode",
    data: zlibWithCmf(0xf8, deflateRawSync(Buffer.from(content), { level: 0 })),
  });

  // Counted, not zero: a budget below its size refuses it.
  await refusesAsBomb(pdf, { ...SMALL, perStream: 10 });

  await assertPdfDecompressionWithinBudget(pdf, SMALL);
  const doc = await getDocumentProxy(pdf.slice());
  try {
    assert.match(await collectPageText(doc), /GUARDPROBE/);
  } finally {
    await doc.destroy();
  }
});

// ── the pdf.js inflater port ──────────────────────────────────────────────

test("the pdf.js inflater port agrees with zlib on valid data, byte for byte", () => {
  // A correct inflater and zlib must produce identical output on valid input,
  // across stored, fixed and dynamic blocks.
  const samples: Buffer[] = [
    Buffer.alloc(0),
    Buffer.from(TEXT),
    Buffer.from("abcabcabcabc".repeat(5000)),
    Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 2654435761) >>> 24)),
    new Uint8Array(300_000) as Buffer,
  ];
  for (const sample of samples) {
    for (const options of [{ level: 0 }, { level: 1 }, { level: 9 }, { strategy: constants.Z_FIXED }, { strategy: constants.Z_HUFFMAN_ONLY }]) {
      const zlibData = deflateSync(sample, options);
      const ours = __test.pdfjsInflate(zlibData, 1 << 30);
      assert.equal(Buffer.compare(Buffer.from(ours), Buffer.from(inflateRawSync(zlibData.subarray(2)))), 0, `${sample.length} bytes, ${JSON.stringify(options)}`);
      assert.equal(__test.pdfjsInflatedSize(zlibData, 1 << 30), sample.length);
    }
  }
});

/** Deflate bit writer: fields LSB-first, Huffman codes reversed, as RFC 1951. */
class Bits {
  private bytes: number[] = [];
  private current = 0;
  private count = 0;
  put(value: number, length: number) {
    for (let i = 0; i < length; i++) {
      this.current |= ((value >> i) & 1) << this.count;
      if (++this.count === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.count = 0;
      }
    }
  }
  code(code: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.put((code >> i) & 1, 1);
  }
  zlib(): Uint8Array {
    const out = [...this.bytes, ...(this.count ? [this.current] : [])];
    return new Uint8Array([0x78, 0x9c, ...out]);
  }
}

test("a back-reference before the start counts on, as in pdf.js, where zlib errors", () => {
  // Fixed block: literal 'A', then length 3 at distance 7 — reaching back past
  // the one byte written. zlib stops with "distance too far back"; pdf.js
  // copies zeros and keeps going. Real europecv PDFs rely on that.
  const bits = new Bits();
  bits.put(1, 1); // BFINAL
  bits.put(1, 2); // fixed Huffman
  bits.code(0x30 + 0x41, 8); // literal 'A'
  bits.code(0b0000001, 7); //   length code 257: 3
  bits.code(5, 5); //           distance code 5: 7 + 1 extra bit
  bits.put(0, 1);
  bits.code(0b0000000, 7); //   end of block
  const data = bits.zlib();

  assert.throws(() => inflateRawSync(data.subarray(2)), /distance too far back/);
  assert.deepEqual([...__test.pdfjsInflate(data, 1024)], [0x41, 0, 0, 0]);
});

test("a stored block is counted at its claimed length, as pdf.js allocates it", () => {
  // pdf.js sets bufferLength to the block's declared length before reading it,
  // so a 60000-byte claim with 10 bytes behind it still allocates 60000.
  const claim = 60000;
  const data = new Uint8Array([0x78, 0x01, 0x01, claim & 0xff, claim >> 8, ~claim & 0xff, (~claim >> 8) & 0xff, ...new Uint8Array(10)]);
  assert.equal(__test.pdfjsInflatedSize(data, 1 << 20), claim);
});

test("a bad stored-block length stops decoding where pdf.js throws", () => {
  const good = deflateRawSync(Buffer.from("kept"), { level: 0 });
  // A second stored block whose NLEN does not complement LEN.
  const bad = new Uint8Array([0x00, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5]);
  const first = Buffer.from(good);
  first[0] &= ~1; // clear BFINAL so pdf.js reads the next block
  const data = new Uint8Array([0x78, 0x01, ...first, ...bad]);
  assert.equal(Buffer.from(__test.pdfjsInflate(data, 1024)).toString(), "kept");
});

test("a header pdf.js rejects is an empty stream, not a refusal", async () => {
  // pdf.js throws in the FlateStream constructor and substitutes a NullStream.
  const pdf = buildPdf({ dict: "/Filter/FlateDecode", data: new Uint8Array([0x78, 0x9d, 0xff, 0xff]) });
  await assertPdfDecompressionWithinBudget(pdf, SMALL);
});

test("a predictor row larger than the budget is refused, whatever the data", async () => {
  // PredictorStream allocates Columns × Colors × BPC bits per row from the
  // parameters alone: 12 bytes of Flate asked pdf.js for a 32MB row.
  const tiny = deflateSync(Buffer.from("x"));
  for (const params of [
    "/DecodeParms<</Predictor 15/Columns 32000000>>",
    "/DP<</Predictor 12/Columns 4000/Colors 4/BPC 16>>",
  ]) {
    await refusesAsBomb(
      buildPdf({ dict: `/Filter/FlateDecode${params}`, data: tiny }),
      { ...SMALL, perStream: 1024 }
    );
  }
});

test("predictor parameters pdf.js would resolve but this cannot are refused", async () => {
  const tiny = deflateSync(Buffer.from("x"));
  for (const dict of [
    "/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 5 0 R>>",
    "/Filter/FlateDecode/DecodeParms<</Predictor/Foo/Columns 5>>",
    "/Filter/FlateDecode/DecodeParms 7 0 R",
    "/Filter[/FlateDecode]/DecodeParms[7 0 R]",
  ]) {
    await assert.rejects(
      () => assertPdfDecompressionWithinBudget(buildPdf({ dict, data: tiny }), SMALL),
      causeMatches(/cannot check/),
      dict
    );
  }
});

test("a stream compressed inside an object stream is refused", async () => {
  // pdf.js parses object streams with allowStreams: true, and takes any stream
  // with /First and /N as one. A small, honestly measured object stream can
  // decompress into a second stream — a bomb the raw scan cannot see.
  const inner = Buffer.concat([
    Buffer.from("7 0 <</Filter/FlateDecode/Length 1024>>stream\n", "latin1"),
    deflateSync(new Uint8Array(16 * MB)),
    Buffer.from("\nendstream", "latin1"),
  ]);
  const objectStream = {
    dict: "/Type/ObjStm/N 1/First 4/Filter/FlateDecode",
    data: deflateSync(inner),
  };
  await assert.rejects(
    () => assertPdfDecompressionWithinBudget(buildPdf(flate(TEXT), [objectStream]), SMALL),
    causeMatches(/stream inside an object stream/)
  );
});

test("an object only reachable by xref offset is parsed and its stream measured", async () => {
  // pdf.js reaches objects by xref offset or by recovery's raw scan, so one
  // after the last %%EOF, or behind a comment line (pdfTeX writes `% 168 0 obj`
  // before objects), is reachable though no walk of the file passes it. Such
  // objects are parsed on their own, as pdf.js would, and measured.
  const bombObject = (num: number) =>
    Buffer.concat([
      Buffer.from(`${num} 0 obj\n<</Filter/FlateDecode/Length ${BOMB.length}>>\nstream\n`, "latin1"),
      BOMB,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ]);

  const afterEof = new Uint8Array(Buffer.concat([Buffer.from(buildPdf(flate(TEXT))), Buffer.from("\n"), bombObject(9)]));
  await refusesAsBomb(afterEof);

  // Inside another stream's data, behind a comment — where pdfTeX's
  // uncompressed object streams put `% 168 0 obj` lines. A walk of the file
  // skips it as data; an xref offset pointing at "9" still reaches it.
  const behindComment = buildPdf(flate(TEXT), [
    { dict: "", data: new Uint8Array(Buffer.concat([Buffer.from("% "), bombObject(9)])) },
  ]);
  await refusesAsBomb(behindComment);
});

test("a stray header or stream that cannot be read as pdf.js would is refused", async () => {
  const unparseable = buildPdf({
    dict: String.raw`/X (5 0 obj << /F /FlateDecode /Y (z\))) `,
    data: new Uint8Array(8),
  });
  const orphanStream = buildPdf({
    dict: "% <</Filter/FlateDecode>> stream\n",
    data: new Uint8Array(8),
  });
  for (const [label, pdf] of [
    ["an object header inside a string, whose object does not parse", unparseable],
    ["a stream keyword in a comment, with no object around it", orphanStream],
  ] as const) {
    await assert.rejects(
      () => assertPdfDecompressionWithinBudget(pdf, SMALL),
      causeMatches(/cannot check/),
      label
    );
  }
});

// ── real files from real producers ────────────────────────────────────────

// Resolved from the app root, which is where the unit suite runs (as in
// safe-fetch.unit.test.ts).
const FIXTURES = resolve("lib/rag/ingest/__fixtures__/pdf");

for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith(".pdf"))) {
  test(`a real ${file.replace(".pdf", "")} PDF passes and still extracts`, async () => {
    // Quartz, Chromium, Ghostscript and pdfTeX (with and without object
    // streams): xref tables and streams, indirect lengths, compressed object
    // streams. A strict reader is only useful if it accepts these.
    const pdf = new Uint8Array(readFileSync(join(FIXTURES, file)));
    await assertPdfDecompressionWithinBudget(pdf);
    const doc = await getDocumentProxy(pdf.slice());
    try {
      assert.match(await collectPageText(doc), /Walrus Memory/);
    } finally {
      await doc.destroy();
    }
  });
}

test("filter values pdf.js would not decode are not refused", async () => {
  // pdf.js decodes only for a name or an array. /F is, per the spec, a file
  // specification, and a string there leaves the stream undecoded; a filter
  // array with non-array parameters just gets no parameters.
  for (const dict of [
    "/F (external.dat) /Filter/FlateDecode",
    "/Filter[/FlateDecode]/DecodeParms<</Predictor 12/Columns 5>>",
  ]) {
    await assertPdfDecompressionWithinBudget(
      buildPdf({ dict, data: deflateSync(Buffer.from(TEXT)) }),
      SMALL
    );
  }
});

test("an ICC profile's /N does not make a stream an object stream", async () => {
  const icc = { dict: "/N 3/Alternate/DeviceRGB/Filter/FlateDecode", data: deflateSync(Buffer.from(">> stream\n")) };
  await assertPdfDecompressionWithinBudget(buildPdf(flate(TEXT), [icc]), SMALL);
});

// ── pdf.js leniency the guard mirrors (from 11,000 real TeX Live PDFs) ────

/** A PDF whose single content stream is written out verbatim, `/Length` included. */
function rawPdf(object4: string | Buffer, trailerExtra = ""): Uint8Array {
  const head = "%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>\nendobj\n";
  return new Uint8Array(Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(object4 as string, "latin1"), Buffer.from(`\ntrailer\n<</Size 5/Root 1 0 R${trailerExtra}>>\nstartxref\n0\n%%EOF\n`, "latin1")]));
}

test("a wrong /Length landing in binary falls back to pdf.js's endstream search", async () => {
  // Real files carry lengths that are off by a few bytes. pdf.js lexes whatever
  // is at start + Length, sees it is not `endstream`, and searches; the strict
  // tokeniser used to refuse the binary instead.
  const data = deflateSync(Buffer.from(TEXT.repeat(20)));
  for (const length of [data.length - 21, data.length + 5]) {
    const pdf = rawPdf(Buffer.concat([Buffer.from(`4 0 obj\n<</Filter/FlateDecode/Length ${length}>>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj", "latin1")]));
    await assertPdfDecompressionWithinBudget(pdf, SMALL);
  }
  // And a bomb behind a wrong length is still measured over the searched region.
  const bomb = rawPdf(Buffer.concat([Buffer.from("4 0 obj\n<</Filter/FlateDecode/Length 10>>\nstream\n", "latin1"), BOMB, Buffer.from("\nendstream\nendobj", "latin1")]));
  await refusesAsBomb(bomb);
});

test("an empty object and a missing endobj are read on, as pdf.js does", async () => {
  // dvips writes `82 0 obj endobj`; other producers omit endobj or leave a
  // dictionary open until a later `>>`. pdf.js reads an object from its header
  // and stops, so none of these is structure it cares about.
  for (const object4 of [
    "4 0 obj\nendobj\n5 0 obj\n<</A 1>>\nendobj",
    "4 0 obj\n<</A 1>>\n5 0 obj\n<</B 2>>\nendobj",
    "4 0 obj\n<<\nendobj\n5 0 obj\n7\nendobj",
  ]) {
    await assertPdfDecompressionWithinBudget(rawPdf(object4), SMALL);
  }
});

test("a trailer with no xref table before it is still read for /Encrypt", async () => {
  // pdf.js's recovery mode reads a standalone `trailer` dictionary.
  await assert.rejects(
    () => assertPdfDecompressionWithinBudget(rawPdf("4 0 obj\n<</A 1>>\nendobj", "/Encrypt 9 0 R"), SMALL),
    causeMatches(/Encrypted/)
  );
});

// ── round 4 on #985 ───────────────────────────────────────────────────────

test("an indirect /Length is not trusted, so a decoy integer cannot slice a bomb", async () => {
  // pdf.js resolves `/Length 8 0 R` through the xref — possibly to an object
  // inside an object stream — not to whatever top-level `8 0 obj` the raw bytes
  // hold. A decoy `8 0 obj 10 endobj` plus an `endstream` planted 10 bytes into
  // the data used to cut the stream there: a stored block of three bytes was
  // measured, and the compressed bomb behind it never was. (Henry, round 4.)
  const deflate = createDeflate({ level: 0 });
  const chunks: Buffer[] = [];
  deflate.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise((resolve) => deflate.on("end", resolve));
  deflate.write(Buffer.from("xyz\nendstream\nendobj\n"));
  await new Promise<void>((resolve) => deflate.flush(constants.Z_FULL_FLUSH, () => resolve()));
  await new Promise<void>((resolve) => deflate.params(9, constants.Z_DEFAULT_STRATEGY, () => resolve()));
  deflate.end(new Uint8Array(16 * MB));
  await done;
  const data = Buffer.concat(chunks);

  // zlib header (2) + stored block header (5) + "xyz" (3): the keyword sits at 10.
  assert.equal(data.indexOf("\nendstream"), 10);

  const bomb = Buffer.concat([
    Buffer.from("9 0 obj\n<</Filter/FlateDecode/Length 8 0 R>>\nstream\n", "latin1"),
    data,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);
  const decoy = { dict: "", data: new Uint8Array(0) };
  const pdf = new Uint8Array(
    Buffer.concat([
      Buffer.from(buildPdf(flate(TEXT), [decoy], "", Buffer.from("8 0 obj\n10\nendobj\n", "latin1"))),
      Buffer.from("\n"),
      bomb,
    ])
  );
  await refusesAsBomb(pdf);
});
