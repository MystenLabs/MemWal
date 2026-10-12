import assert from "node:assert/strict";
import test from "node:test";

import { ChatbotError } from "@/lib/errors";

import {
  CHAT_ANSWER_RESERVE_MS,
  MAX_PDF_EXTRACT_MS,
  MAX_SOURCES_PER_REQUEST,
  MIN_SOURCE_TIME_MS,
  OUT_OF_TIME_REASON,
  ingestDeadline,
} from "./limits";

/** How many sources of `takesMs` each start before the loop runs short. */
function expectedStarts(count: number, takesMs: number): number {
  const deadline = ingestDeadline(0, CHAT_MAX_DURATION_S);
  let now = 0;
  let starts = 0;
  while (starts < Math.min(count, MAX_SOURCES_PER_REQUEST) && deadline - now >= MIN_SOURCE_TIME_MS) {
    now += takesMs;
    starts++;
  }
  return starts;
}
import { ingestMessageSources } from "./message-sources";

// WALM-683, review on #985: the chat route's maxDuration is 120s and it still
// has to stream the answer after ingesting. Five PDFs in a row, each allowed a
// 30s read plus up to 30s waiting for a reader, did not fit, and Next would cut
// the request off mid-ingest. These run the real loop on a fake clock.

const CHAT_MAX_DURATION_S = 120;


function pdfs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    type: "pdf" as const,
    fileUrl: `https://example.com/${i + 1}.pdf`,
    fileName: `${i + 1}.pdf`,
  }));
}

function fakeClock() {
  let now = 0;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

type Written = { type: string; data: Record<string, unknown> };

async function run(options: {
  count: number;
  /** How long one source takes when nothing stops it. */
  takesMs: number;
  /** Honour deadlineAt the way the PDF reader and the downloads do. */
  honoursDeadline?: boolean;
}) {
  const clock = fakeClock();
  const deadlineAt = ingestDeadline(clock.now(), CHAT_MAX_DURATION_S);
  const written: Written[] = [];
  const started: Array<{ file: string; at: number; deadlineAt: number }> = [];

  const processed = await ingestMessageSources({
    sources: pdfs(options.count),
    deadlineAt,
    now: clock.now,
    write: (event) => written.push(event as Written),
    ingest: async (source, sourceDeadline) => {
      started.push({ file: source.fileName, at: clock.now(), deadlineAt: sourceDeadline });
      const left = sourceDeadline - clock.now();
      if (options.honoursDeadline && options.takesMs > left) {
        clock.advance(left);
        throw new ChatbotError("bad_request:api", OUT_OF_TIME_REASON);
      }
      clock.advance(options.takesMs);
      return { title: source.fileName, chunkCount: 1, sourceId: source.fileName };
    },
  });

  return { processed, written, started, deadlineAt, endedAt: clock.now() };
}

const errorsFor = (written: Written[]) =>
  written
    .filter((e) => e.type === "data-source-error")
    .map((e) => `${e.data.label}: ${e.data.error}`);

test("ingestion ends early enough to leave the answer its reserve", () => {
  assert.equal(
    ingestDeadline(1000, CHAT_MAX_DURATION_S),
    1000 + CHAT_MAX_DURATION_S * 1000 - CHAT_ANSWER_RESERVE_MS
  );
  assert.ok(ingestDeadline(0, CHAT_MAX_DURATION_S) < CHAT_MAX_DURATION_S * 1000);
});

test("five PDFs at a full read each: the ones that fit run, the rest are reported, and the route budget holds", async () => {
  const { processed, written, started, deadlineAt, endedAt } = await run({
    count: 5,
    takesMs: MAX_PDF_EXTRACT_MS,
  });

  // With the defaults (120s route, 30s reserve, 30s per read, 15s minimum to
  // start) that is 3 of 5; the expectation is derived so env overrides hold.
  const starts = expectedStarts(5, MAX_PDF_EXTRACT_MS);
  assert.ok(starts < 5, "the premise: five full reads do not fit");
  assert.equal(started.length, starts);
  assert.equal(processed, starts);
  assert.deepEqual(
    errorsFor(written),
    pdfs(5)
      .slice(starts)
      .map((p) => `${p.fileName}: ${OUT_OF_TIME_REASON}`)
  );
  assert.ok(endedAt <= deadlineAt, `ingest ran to ${endedAt}ms, past ${deadlineAt}ms`);
  assert.ok(endedAt + CHAT_ANSWER_RESERVE_MS <= CHAT_MAX_DURATION_S * 1000);
});

test("worst case, a read plus a full wait for a reader each, still ends by the deadline", async () => {
  const { written, started, deadlineAt, endedAt } = await run({
    count: 5,
    takesMs: 2 * MAX_PDF_EXTRACT_MS,
    honoursDeadline: true,
  });

  assert.ok(endedAt <= deadlineAt, `ingest ran to ${endedAt}ms, past ${deadlineAt}ms`);
  // Every source gets the route's deadline, not a fresh budget of its own.
  assert.ok(started.every((s) => s.deadlineAt === deadlineAt));
  // Every source is accounted for on the stream: processed, failed, or skipped.
  const processing = written.filter((e) => e.type === "data-source-processing");
  assert.equal(processing.length, 5);
  assert.equal(written.at(-1)?.type, "data-sources-done");
});

test("a source is not started with less than the minimum left", async () => {
  const takesMs = ingestDeadline(0, CHAT_MAX_DURATION_S) - MIN_SOURCE_TIME_MS + 1;
  const { started, written } = await run({ count: 2, takesMs });
  assert.deepEqual(started.map((s) => s.file), ["1.pdf"]);
  assert.deepEqual(errorsFor(written), [`2.pdf: ${OUT_OF_TIME_REASON}`]);
});

test("the stream shows why a source failed, not the generic error text", async () => {
  const written: Written[] = [];
  const reasons = [
    new ChatbotError("rate_limit:api", "Too many PDFs are being read right now. Please try again in a minute."),
    new ChatbotError("bad_request:api", "This PDF took too long to read."),
    new Error("socket hang up"),
  ];
  await ingestMessageSources({
    sources: pdfs(3),
    deadlineAt: Number.MAX_SAFE_INTEGER,
    write: (event) => written.push(event as Written),
    ingest: async () => {
      throw reasons.shift();
    },
  });
  assert.deepEqual(errorsFor(written), [
    "1.pdf: Too many PDFs are being read right now. Please try again in a minute.",
    "2.pdf: This PDF took too long to read.",
    "3.pdf: socket hang up",
  ]);
});

test("every unprocessed source gets a processing event before its error, so the panel shows it", async () => {
  const { written } = await run({ count: 7, takesMs: MAX_PDF_EXTRACT_MS });
  const labels = new Set<string>();
  for (const event of written) {
    if (event.type === "data-source-processing") {
      labels.add(String(event.data.label));
    }
    if (event.type === "data-source-error") {
      assert.ok(labels.has(String(event.data.label)), `orphan error for ${event.data.label}`);
    }
  }
  // Past the per-message cap, plus the kept ones that ran out of time.
  const overCap = 7 - MAX_SOURCES_PER_REQUEST;
  const outOfTime = MAX_SOURCES_PER_REQUEST - expectedStarts(7, MAX_PDF_EXTRACT_MS);
  assert.equal(errorsFor(written).length, overCap + outOfTime);
});
