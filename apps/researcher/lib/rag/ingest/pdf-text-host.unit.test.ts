import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { getDocumentProxy } from "unpdf";

import { ChatbotError } from "@/lib/errors";

import { collectPageText } from "./limits";
import { assertPdfDecompressionWithinBudget } from "./pdf-guard";
import { extractPdfTextIsolated } from "./pdf-text-host";

// WALM-683 follow-up. The decompression guard bounds how far each stream
// inflates, not how many times pdf.js decodes it. These files pass the guard,
// then make pdf.js decode one stream over and over, synchronously.

type Obj = string | { dict: string; data: Buffer };

function assemble(objects: Obj[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
  let length = parts[0].length;
  const offsets: number[] = [];
  const push = (chunk: Buffer) => {
    parts.push(chunk);
    length += chunk.length;
  };
  objects.forEach((object, index) => {
    const num = index + 1;
    offsets[num] = length;
    if (typeof object === "string") {
      push(Buffer.from(`${num} 0 obj\n${object}\nendobj\n`));
    } else {
      push(Buffer.from(`${num} 0 obj\n${object.dict} /Length ${object.data.length} >>\nstream\n`));
      push(object.data);
      push(Buffer.from("\nendstream\nendobj\n"));
    }
  });
  const xrefAt = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= objects.length; num++) {
    xref += `${String(offsets[num]).padStart(10, "0")} 00000 n \n`;
  }
  push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

/** Content that inflates to `mb` MB of no-op operators, with one word of text. */
function heavyContent(mb: number): Buffer {
  return deflateSync(
    Buffer.from(`BT /F1 12 Tf 72 720 Td (hi) Tj ET\n${"q Q ".repeat(mb * 262_144)}`),
    { level: 9 }
  );
}

const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

/** One heavy content stream (object 3) used as /Contents by every page. */
function sharedContentPdf(pages: number, mb: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, i) => `${5 + i} 0 R`).join(" ");
  const objects: Obj[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    { dict: "<< /Filter /FlateDecode", data: heavyContent(mb) },
    FONT,
  ];
  for (let i = 0; i < pages; i++) {
    objects.push(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 3 0 R >>"
    );
  }
  return assemble(objects);
}

/** One page whose content draws a heavy Form XObject `draws` times. */
function repeatedFormPdf(draws: number, mb: number): Uint8Array {
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    {
      dict: "<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Filter /FlateDecode",
      data: heavyContent(mb),
    },
    FONT,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Fm1 3 0 R >> >> /Contents 6 0 R >>",
    { dict: "<< /Filter /FlateDecode", data: deflateSync(Buffer.from("/Fm1 Do\n".repeat(draws))) },
  ]);
}

function causeMatches(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ChatbotError, `expected ChatbotError, got ${String(error)}`);
    assert.match(String(error.cause), pattern);
    return true;
  };
}

/** Run `fn` while counting how often a 50ms timer gets to fire. */
async function withEventLoopProbe<T>(fn: () => Promise<T>) {
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
  }, 50);
  const started = Date.now();
  try {
    const outcome = await fn().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    return { outcome, ticks, elapsed: Date.now() - started };
  } finally {
    clearInterval(interval);
  }
}

for (const [label, build] of [
  ["a Form XObject drawn hundreds of times on one page", () => repeatedFormPdf(400, 8)],
  ["pages that all share one heavy content stream", () => sharedContentPdf(300, 8)],
] as const) {
  test(`${label} passes the guard, then is stopped at the deadline`, async () => {
    const pdf = build();
    // The premise: the guard alone lets this through.
    await assertPdfDecompressionWithinBudget(pdf);

    const { outcome, ticks, elapsed } = await withEventLoopProbe(() =>
      extractPdfTextIsolated(pdf, { deadlineMs: 1500 })
    );

    assert.equal(outcome.ok, false, "extraction must not run to completion");
    if (!outcome.ok) {
      causeMatches(/too long/)(outcome.error);
    }
    assert.ok(elapsed < 5000, `stopped after ${elapsed}ms, deadline was 1500ms`);
    // On the main thread pdf.js held the loop for the whole decode; in the
    // worker, timers keep firing while it runs.
    assert.ok(ticks >= 10, `the event loop only ticked ${ticks} times in ${elapsed}ms`);
  });
}

// Same convention as pdf-guard.unit.test.ts: the suite runs from the app directory.
const FIXTURES = resolve("lib/rag/ingest/__fixtures__/pdf");

test("the worker returns exactly what in-process extraction returned, on every fixture", async () => {
  const files = readdirSync(FIXTURES).filter((name) => name.endsWith(".pdf"));
  assert.ok(files.length > 0, "fixtures are missing");
  for (const name of files) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
    const doc = await getDocumentProxy(bytes.slice());
    let expected: string;
    try {
      expected = await collectPageText(doc);
    } finally {
      await doc.destroy();
    }
    const actual = await extractPdfTextIsolated(bytes);
    assert.equal(actual, expected, `${name}: text differs`);
  }
});

test("the caller's buffer is left intact", async () => {
  const [first] = readdirSync(FIXTURES).filter((name) => name.endsWith(".pdf"));
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, first)));
  const length = bytes.byteLength;
  await extractPdfTextIsolated(bytes);
  assert.equal(bytes.byteLength, length, "the buffer was transferred away");
});

test("a file pdf.js cannot open is a ChatbotError, not a crash or a hang", async () => {
  const garbage = new TextEncoder().encode("%PDF-1.7\nthis is not a pdf\n");
  await assert.rejects(
    () => extractPdfTextIsolated(garbage, { deadlineMs: 10_000 }),
    causeMatches(/Could not read this PDF/)
  );
});
