import { getSession } from "@/lib/auth/session";
import { getChatById, getSprintByChatId, createSprintBlob } from "@/lib/db/queries";
import { generateSprintReport } from "@/lib/sprint/report";
import { rememberSprintReport } from "@/lib/sprint/memwal";
import { ChatbotError } from "@/lib/errors";
import type { SourceMeta } from "@/lib/sprint/types";

export const maxDuration = 120;

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: Request) {
  const session = await getSession();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const userId = session.user.id;

  let chatId: string;
  try {
    const body = await request.json();
    chatId = body.chatId;
    if (!chatId || typeof chatId !== "string") {
      return new ChatbotError(
        "bad_request:api",
        "Expected a chatId field"
      ).toResponse();
    }
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const memwalKey = session.user.privateKey || process.env.MEMWAL_KEY;
  if (!memwalKey) {
    return new ChatbotError(
      "bad_request:api",
      "No MemWal key provided"
    ).toResponse();
  }

  console.log(`[sprint:save] Starting SSE save for chat=${chatId}, user=${userId.slice(0, 8)}...`);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      try {
        // Step 1: Verify chat ownership
        send("step", { step: "verify", status: "start", message: "Verifying chat..." });
        console.log(`[sprint:save] Verifying chat=${chatId}`);

        const chat = await getChatById({ id: chatId });
        if (!chat) {
          send("error", { message: "Chat not found" });
          controller.close();
          return;
        }
        if (chat.userId !== userId) {
          send("error", { message: "Chat belongs to another user" });
          controller.close();
          return;
        }

        console.log(`[sprint:save] Chat verified`);
        send("step", { step: "verify", status: "done", message: "Chat verified" });

        // Step 2: Check duplicate sprint
        send("step", { step: "check-duplicate", status: "start", message: "Checking existing sprint..." });
        console.log(`[sprint:save] Checking for existing sprint on chat=${chatId}`);

        const existing = await getSprintByChatId({ chatId });
        if (existing) {
          send("error", { message: "This chat already has a saved sprint" });
          controller.close();
          return;
        }

        console.log(`[sprint:save] No existing sprint found`);
        send("step", { step: "check-duplicate", status: "done", message: "No duplicate found" });

        // Step 3: Generate report (slowest step)
        send("step", { step: "generate-report", status: "start", message: "Generating report..." });
        console.log(`[sprint:save] Generating report...`);

        const report = await generateSprintReport({ chatId, userId });

        console.log(`[sprint:save] Report generated: "${report.title}"`);
        send("step", { step: "generate-report", status: "done", message: `Report: "${report.title}"` });

        // Step 4: Build source metadata from citations (deduplicate)
        send("step", { step: "build-sources", status: "start", message: "Processing sources..." });
        console.log(`[sprint:save] Building sources from ${report.citations.length} citations`);

        const sourceMap = new Map<string, SourceMeta>();
        for (const citation of report.citations) {
          if (!sourceMap.has(citation.sourceId)) {
            sourceMap.set(citation.sourceId, {
              sourceId: citation.sourceId,
              title: citation.sourceTitle,
              url: citation.sourceUrl,
              type: citation.sourceUrl ? "url" : "pdf",
            });
          }
        }

        // Further deduplicate by title
        const seenTitles = new Set<string>();
        const sources: SourceMeta[] = [];
        for (const s of sourceMap.values()) {
          const key = s.title?.toLowerCase() ?? s.sourceId;
          if (!seenTitles.has(key)) {
            seenTitles.add(key);
            sources.push(s);
          }
        }

        console.log(`[sprint:save] ${sources.length} unique sources`);
        send("step", { step: "build-sources", status: "done", message: `${sources.length} sources processed` });

        // Step 5: Store in MemWal
        send("step", { step: "store-memwal", status: "start", message: "Storing in MemWal..." });
        console.log(`[sprint:save] Storing in MemWal...`);

        const memwalResult = await rememberSprintReport({
          key: memwalKey,
          title: report.title,
          content: report.content,
          citations: report.citations,
          sources,
        });

        console.log(`[sprint:save] MemWal stored. blobId=${memwalResult.blobId}`);
        send("step", { step: "store-memwal", status: "done", message: "Stored in MemWal" });

        // Step 6: Save to database
        send("step", { step: "save-db", status: "start", message: "Saving to database..." });
        console.log(`[sprint:save] Saving to DB...`);

        const tags = [...new Set(sources.map((s) => s.title).filter(Boolean))] as string[];
        const sprintRecord = await createSprintBlob({
          chatId,
          userId,
          blobId: memwalResult.blobId,
          title: report.title,
          summary: report.summary,
          reportContent: report.content,
          citations: report.citations,
          sources,
          tags: tags.length > 0 ? tags : undefined,
          memoryCount: 1,
        });

        console.log(`[sprint:save] Sprint saved! id=${sprintRecord.id}, blobId=${memwalResult.blobId}`);
        send("step", { step: "save-db", status: "done", message: "Saved to database" });

        // Done — send ready event
        send("ready", {
          title: report.title,
          sprintId: sprintRecord.id,
          blobId: memwalResult.blobId,
        });
        console.log(`[sprint:save] SSE save complete for chat=${chatId}`);
      } catch (err) {
        console.error("[sprint:save] Pipeline error:", err);
        send("error", {
          message: err instanceof Error ? err.message : "Failed to save sprint",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
