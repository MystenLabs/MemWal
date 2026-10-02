import assert from "node:assert/strict";
import test from "node:test";

import { ChatbotError } from "@/lib/errors";

import {
  MAX_SOURCE_BYTES,
  assertLooksLikePdf,
  assertSourceFileWithinBudget,
  capExtractedText,
  MAX_EXTRACTED_CHARS,
  readCappedBytes,
  readCappedText,
} from "./limits";

/**
 * `ChatbotError` keeps a generic user-facing `message` and puts the specific
 * reason in `cause`, so assertions go against `cause`.
 */
function causeMatches(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ChatbotError, `expected a ChatbotError, got ${error}`);
    assert.match(String(error.cause), pattern);
    return true;
  };
}

function streamingResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {}
): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  // Chunks are produced on demand rather than enqueued up front, so the stream
  // is still open when a cap rejects mid-read — which is the state a real
  // download is in, and the only state where cancelling it means anything.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      cancelled = true;
    },
  });

  return {
    response: new Response(stream, { headers }),
    cancelled: () => cancelled,
  };
}

test("readCappedBytes returns a body that fits the budget", async () => {
  const { response } = streamingResponse([
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4, 5]),
  ]);

  const bytes = await readCappedBytes(response, 16);
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
});

test("readCappedBytes refuses a body that exceeds the cap mid-stream", async () => {
  // No Content-Length at all: the running total is what has to stop this, not
  // anything the remote side declared.
  const { response } = streamingResponse([
    new Uint8Array(8),
    new Uint8Array(8),
    new Uint8Array(8),
  ]);

  await assert.rejects(() => readCappedBytes(response, 16), causeMatches(/larger than/));
});

test("readCappedBytes does not trust an understated Content-Length", async () => {
  // The header claims one byte; the body sends far more. A limiter that trusted
  // the header would buffer all of it.
  const { response } = streamingResponse(
    [new Uint8Array(64), new Uint8Array(64)],
    { "content-length": "1" }
  );

  await assert.rejects(() => readCappedBytes(response, 32), causeMatches(/larger than/));
});

test("readCappedBytes rejects an oversized Content-Length before reading", async () => {
  const { response, cancelled } = streamingResponse([new Uint8Array(4)], {
    "content-length": String(MAX_SOURCE_BYTES + 1),
  });

  await assert.rejects(() => readCappedBytes(response), causeMatches(/larger than/));
  assert.equal(cancelled(), true, "the transfer must be cancelled, not left running");
});

test("readCappedBytes cancels the stream when it rejects mid-read", async () => {
  // "A rejection does not leave partial unbounded work running."
  const { response, cancelled } = streamingResponse([
    new Uint8Array(8),
    new Uint8Array(8),
  ]);

  await assert.rejects(() => readCappedBytes(response, 8), causeMatches(/larger than/));
  assert.equal(cancelled(), true);
});

test("readCappedText decodes within the same budget", async () => {
  const { response } = streamingResponse([new TextEncoder().encode("hello")]);
  assert.equal(await readCappedText(response, 32), "hello");
});

test("assertSourceFileWithinBudget rejects a non-File form value", () => {
  // The route used `formData.get("file") as File`, which a plain text field
  // satisfies at runtime.
  assert.throws(
    () => assertSourceFileWithinBudget("not-a-file" as unknown as File),
    causeMatches(/Expected a PDF file/)
  );
  assert.throws(() => assertSourceFileWithinBudget(null), causeMatches(/Expected a PDF file/));
});

test("assertSourceFileWithinBudget rejects an oversized upload", () => {
  const huge = new File([new Uint8Array(4)], "big.pdf");
  Object.defineProperty(huge, "size", { value: MAX_SOURCE_BYTES + 1 });

  assert.throws(() => assertSourceFileWithinBudget(huge), causeMatches(/larger than/));
});

test("assertSourceFileWithinBudget accepts a file inside the budget", () => {
  const file = new File([new Uint8Array(8)], "fine.pdf");
  assert.equal(assertSourceFileWithinBudget(file), file);
});

test("assertLooksLikePdf checks content, not the filename", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\nbody");
  assert.doesNotThrow(() => assertLooksLikePdf(pdf));

  // A .pdf suffix on something that is not a PDF was the only check before.
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
  assert.throws(() => assertLooksLikePdf(zip), causeMatches(/not a PDF/));
  assert.throws(() => assertLooksLikePdf(new Uint8Array([0x25])), causeMatches(/not a PDF/));
  assert.throws(() => assertLooksLikePdf(new Uint8Array()), causeMatches(/not a PDF/));
});

test("capExtractedText truncates past the character budget", () => {
  const short = "a".repeat(32);
  assert.equal(capExtractedText(short), short);

  const long = "a".repeat(MAX_EXTRACTED_CHARS + 500);
  assert.equal(capExtractedText(long).length, MAX_EXTRACTED_CHARS);
});

// ── review follow-ups on #985 ─────────────────────────────────────────────

import { extractText, getDocumentProxy } from "unpdf";
import { unstable_doesMiddlewareMatch } from "next/dist/experimental/testing/server/middleware-testing-utils";

import {
  collectPageText,
  discardBody,
  droppedSourceEvents,
  MAX_JSON_BODY_BYTES,
  MAX_PDF_PAGES,
  type PdfTextSource,
  readCappedRequestBody,
  selectSourcesWithinBudget,
} from "./limits";
import { config as proxyConfig } from "../../../proxy";

function streamingRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {}
): { request: Request; cancelled: () => boolean; pulled: () => number } {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/api/research/process-source", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
  return { request, cancelled: () => cancelled, pulled: () => index };
}

test("an oversized upload is refused and its stream cancelled, not read to the end", async () => {
  // The route used to call request.formData() — which buffers everything — and
  // only then look at File.size. Here the raw stream is capped: reading stops
  // at the budget and the rest of the body is never pulled.
  const { request, cancelled, pulled } = streamingRequest(
    Array.from({ length: 50 }, () => new Uint8Array(1024))
  );

  await assert.rejects(
    () => readCappedRequestBody(request, 4 * 1024),
    causeMatches(/larger than/)
  );
  assert.equal(cancelled(), true, "the upload must be cancelled");
  assert.ok(pulled() < 50, `read ${pulled()} of 50 chunks; must stop early`);
});

test("a declared Content-Length over budget is refused before reading anything", async () => {
  const { request, pulled } = streamingRequest([new Uint8Array(8)], {
    "content-length": String(10 * 1024 * 1024),
  });

  await assert.rejects(
    () => readCappedRequestBody(request, 1024),
    causeMatches(/larger than/)
  );
  assert.equal(pulled(), 0);
});

test("discardBody releases a response that will not be read", async () => {
  // Throwing on !response.ok used to leave the body streaming, so a 500 with an
  // endless body held the socket without ever reaching the byte cap.
  const { response, cancelled } = streamingResponse([new Uint8Array(8)]);
  await discardBody(response);
  assert.equal(cancelled(), true);
});

function fakeDoc(pages: string[]): PdfTextSource & { opened: () => number } {
  let opened = 0;
  return {
    numPages: pages.length,
    opened: () => opened,
    async getPage(pageNumber: number) {
      opened += 1;
      return {
        async getTextContent() {
          return { items: [{ str: pages[pageNumber - 1] }] };
        },
      };
    },
  };
}

test("collectPageText stops opening pages once the character budget is spent", async () => {
  // mergePages decoded every page before any cap could look at the text, so the
  // cap bounded what was kept, not what was decoded.
  const doc = fakeDoc(Array.from({ length: 100 }, () => "x".repeat(100)));

  const text = await collectPageText(doc, 350);

  assert.equal(text.length, 350);
  assert.ok(doc.opened() <= 4, `opened ${doc.opened()} pages for a 350-char budget`);
});

test("collectPageText refuses an absurd page count before opening any page", async () => {
  const doc = fakeDoc(Array.from({ length: MAX_PDF_PAGES + 1 }, () => "x"));

  await assert.rejects(() => collectPageText(doc), causeMatches(/page limit/));
  assert.equal(doc.opened(), 0);
});

/** A minimal text PDF with one line per page, built by hand so offsets are exact. */
function buildPdf(pageTexts: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds: number[] = [];
  const fontId = 3;
  objects[1] = "<</Type/Catalog/Pages 2 0 R>>";
  objects[fontId] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  let next = 4;
  for (const text of pageTexts) {
    const content = `BT /F1 12 Tf 10 100 Td (${text}) Tj ET`;
    const contentId = next++;
    const pageId = next++;
    objects[contentId] = `<</Length ${content.length}>>stream\n${content}\nendstream`;
    objects[pageId] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`;
    pageIds.push(pageId);
  }
  objects[2] = `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(" ")}]/Count ${pageIds.length}>>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

test("a real PDF goes through pdf.js page by page and stops at the budget", async () => {
  const pages = Array.from({ length: 30 }, (_, i) => `page-${i + 1}-${"y".repeat(40)}`);
  const doc = await getDocumentProxy(buildPdf(pages));
  let opened = 0;
  const counting: PdfTextSource = {
    numPages: doc.numPages,
    getPage: (n) => {
      opened += 1;
      return doc.getPage(n);
    },
  };

  try {
    assert.equal(doc.numPages, 30);
    const text = await collectPageText(counting, 120);
    assert.match(text, /^page-1-/);
    assert.equal(text.length, 120);
    assert.ok(opened < 30, `decoded ${opened} of 30 pages for a 120-char budget`);
  } finally {
    await doc.destroy();
  }
});

test("selectSourcesWithinBudget keeps attachments ahead of scraped URLs", () => {
  // URLs are collected before file parts, so keeping the first five in order
  // let five cited links silently push an uploaded PDF out.
  const sources = [
    ...Array.from({ length: 5 }, (_, i) => ({ type: "url", url: `https://e.com/${i}` })),
    { type: "pdf", fileUrl: "https://blob/x.pdf", fileName: "x.pdf" },
  ];

  const { kept, dropped } = selectSourcesWithinBudget(sources, 5);

  assert.equal(kept[0].type, "pdf", "the attachment must be kept");
  assert.equal(kept.length, 5);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].type, "url");
});

/** Every spelling of `path` with exactly one character percent-encoded, both hex cases. */
function singleEncodings(path: string): string[] {
  const spellings: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const hex = path.charCodeAt(i).toString(16).padStart(2, "0");
    for (const variant of new Set([hex.toLowerCase(), hex.toUpperCase()])) {
      spellings.push(`${path.slice(0, i)}%${variant}${path.slice(i + 1)}`);
    }
  }
  return spellings;
}

function encodeAll(path: string, upper: boolean): string {
  return (
    "/" +
    Array.from(path.slice(1), (ch) => {
      const hex = ch.charCodeAt(0).toString(16).padStart(2, "0");
      return `%${upper ? hex.toUpperCase() : hex}`;
    }).join("")
  );
}

test("the upload route is outside the proxy in every single-encoded spelling", () => {
  // Next tests the matcher against the raw pathname and percent-decodes only
  // when routing, so /api/research/%70rocess-source reaches the route. A
  // literal-only exclusion let every encoded spelling through the proxy, whose
  // body clone drains and truncates the upload (Henry, round 2).
  const matches = (url: string) =>
    unstable_doesMiddlewareMatch({ config: proxyConfig, url });
  const route = "/api/research/process-source";

  const spellings = [
    route,
    `${route}/`,
    `${route}%2F`,
    `${route}%2f`,
    ...singleEncodings(route),
    encodeAll(route, false),
    encodeAll(route, true),
    "/api/research%2Fprocess-source",
    "/api%2fresearch%2fprocess-source",
  ];
  // 27 characters, a few of whose hex codes have a letter and so two cases.
  assert.ok(spellings.length >= 40, `only ${spellings.length} spellings generated`);
  for (const url of spellings) {
    assert.equal(matches(url), false, `${url} must not go through the proxy`);
  }

  for (const url of [
    "/api/chat",
    "/api/research/other",
    "/api/research/process-sourcex",
    "/api/research/%70rocess-sourcex",
    "/api/sprint/save",
    "/",
    "/chat/abc",
    "/login",
  ]) {
    assert.equal(matches(url), true, `${url} must still go through the proxy`);
  }
});

// ── round 2 on #985 ───────────────────────────────────────────────────────

/** A text PDF whose pages are raw content streams, built with exact offsets. */
function buildContentPdf(pageContents: string[]): Uint8Array {
  const objects: string[] = [];
  objects[1] = "<</Type/Catalog/Pages 2 0 R>>";
  objects[3] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>";
  objects[4] = "<</Type/Font/Subtype/Type1/BaseFont/Helvetica-Bold>>";
  const kids: number[] = [];
  let next = 5;
  for (const content of pageContents) {
    const contentId = next++;
    const pageId = next++;
    objects[contentId] = `<</Length ${content.length}>>stream\n${content}\nendstream`;
    objects[pageId] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 400]/Contents ${contentId} 0 R/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>>>`;
    kids.push(pageId);
  }
  objects[2] = `<</Type/Pages/Kids[${kids.map((id) => `${id} 0 R`).join(" ")}]/Count ${kids.length}>>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objects.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

test("collectPageText returns exactly what extractText(mergePages) returned", async () => {
  // The review caught that joining items with " " split kerned words ("Hel lo")
  // and dropped hasEOL. Rather than argue about the rule, pin parity with the
  // function this replaced, on the cases that differ: a word split into kerned
  // TJ runs, several lines on one page, runs of whitespace, an empty page, and
  // a page break.
  const pdf = buildContentPdf([
    "BT /F1 12 Tf 20 360 Td [(Hel) -30 (lo) 10 (,)] TJ ( world) Tj 0 -16 Td (second   line) Tj 0 -16 Td [(kern) -120 (ed)] TJ ET",
    "BT ET",
    "BT /F1 12 Tf 20 360 Td (third page) Tj 0 -16 Td (  indented) Tj 0 -16 Td (Sepa) Tj /F2 12 Tf (rate) Tj ET",
  ]);

  // pdf.js transfers the buffer it is given to its worker, detaching it, so
  // each call gets its own copy.
  const expected = (await extractText(pdf.slice(), { mergePages: true })).text;
  const doc = await getDocumentProxy(pdf.slice());
  try {
    const actual = await collectPageText(doc);
    assert.equal(actual, expected);
    assert.match(actual, /Hello,/, "kerned runs must stay one word");
    // A font change mid-word (bold, italic, a ligature font) makes pdf.js return
    // the word as two items; joining items with " " — the previous commit's
    // rule — gave "Sepa rate".
    assert.match(actual, /Separate/, "a word split by a font change must stay whole");
  } finally {
    await doc.destroy();
  }
});

test("a dropped source gets a processing event before its error, so the panel shows it", () => {
  // The activity panel only builds a step from data-source-processing and then
  // attaches a matching data-source-error; an error on its own was never shown.
  const events = droppedSourceEvents(
    [
      { type: "url", url: "https://e.com/6" },
      { type: "pdf", fileName: "report.pdf" },
    ],
    5
  );

  assert.deepEqual(
    events.map((event) => [event.type, event.data.label]),
    [
      ["data-source-processing", "https://e.com/6"],
      ["data-source-error", "https://e.com/6"],
      ["data-source-processing", "report.pdf"],
      ["data-source-error", "report.pdf"],
    ]
  );
});

test("a limit under a megabyte is reported in KB, not as 0MB", async () => {
  const { request } = streamingRequest([new Uint8Array(MAX_JSON_BODY_BYTES + 1)]);
  await assert.rejects(
    () => readCappedRequestBody(request, MAX_JSON_BODY_BYTES),
    causeMatches(/16KB limit/)
  );
});
