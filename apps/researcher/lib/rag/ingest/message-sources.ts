import { ChatbotError } from "@/lib/errors";

import {
  MIN_SOURCE_TIME_MS,
  OUT_OF_TIME_REASON,
  droppedSourceEvents,
  selectSourcesWithinBudget,
  timeLeft,
  unprocessedSourceEvents,
} from "./limits";

type MessageSource = { type: string; url?: string; fileName?: string };

type SourceStreamEvent =
  | { type: "data-source-processing"; data: { label: string }; transient: true }
  | {
      type: "data-source-processed";
      data: { title: string; chunkCount: number; sourceId: string };
      transient: true;
    }
  | {
      type: "data-source-error";
      data: { label: string; error: string };
      transient: true;
    }
  | { type: "data-sources-done"; data: { count: number }; transient: true };

function labelOf(source: MessageSource): string {
  return (source.type === "url" ? source.url : source.fileName) ?? "";
}

/**
 * What the user sees for a failed source. A ChatbotError's `message` is the
 * generic text for its code; the specific reason ("took too long", "too many
 * PDFs are being read") is in `cause`, and that is the part worth showing.
 */
function describeFailure(error: unknown): string {
  if (error instanceof ChatbotError && typeof error.cause === "string") {
    return error.cause;
  }
  return error instanceof Error ? error.message : "Failed to process source";
}

/**
 * Ingest the sources attached to one chat message, one after another, inside
 * the time the route has left (WALM-683).
 *
 * The chat route has a fixed maxDuration and still has to stream the answer
 * after ingestion. Each PDF can take a reader deadline plus a wait for a free
 * reader, so five of them in a row could outlast the route, and Next would cut
 * the request off mid-ingest. Instead every source gets `deadlineAt` to pass
 * down, and once less than `minSourceTimeMs` is left, the remaining sources are
 * reported on the stream as not processed rather than started.
 *
 * Returns how many sources were processed.
 */
export async function ingestMessageSources<S extends MessageSource>({
  sources,
  deadlineAt,
  ingest,
  write,
  now = Date.now,
  minSourceTimeMs = MIN_SOURCE_TIME_MS,
}: {
  sources: S[];
  deadlineAt: number;
  ingest: (
    source: S,
    deadlineAt: number
  ) => Promise<{ title: string; chunkCount: number; sourceId: string }>;
  write: (event: SourceStreamEvent) => void;
  now?: () => number;
  minSourceTimeMs?: number;
}): Promise<number> {
  // One message can carry any number of file parts and URLs, and each one is a
  // full ingestion, so cap how many a single request starts. Attachments are
  // kept ahead of URLs scraped from prose, and every source that is not started
  // is reported on the stream, not just logged.
  const { kept, dropped } = selectSourcesWithinBudget(sources);
  for (const event of droppedSourceEvents(dropped)) {
    write(event);
  }

  let processedCount = 0;

  for (const [index, source] of kept.entries()) {
    if (timeLeft(deadlineAt, now()) < minSourceTimeMs) {
      for (const event of unprocessedSourceEvents(
        kept.slice(index),
        OUT_OF_TIME_REASON
      )) {
        write(event);
      }
      break;
    }

    const label = labelOf(source);
    write({ type: "data-source-processing", data: { label }, transient: true });

    try {
      const result = await ingest(source, deadlineAt);
      write({
        type: "data-source-processed",
        data: {
          title: result.title,
          chunkCount: result.chunkCount,
          sourceId: result.sourceId,
        },
        transient: true,
      });
      processedCount++;
    } catch (error) {
      console.error("Source processing error:", error);
      write({
        type: "data-source-error",
        data: { label, error: describeFailure(error) },
        transient: true,
      });
    }
  }

  write({
    type: "data-sources-done",
    data: { count: processedCount },
    transient: true,
  });

  return processedCount;
}
