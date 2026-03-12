import "server-only";

import { getChatById, getSprintByChatId, createSprintBlob } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { generateSprintReport } from "./report";
import { rememberSprintReport } from "./memwal";
import type { SourceMeta, SaveSprintResult } from "./types";

/**
 * Save a research sprint: generate report, store in MemWal, persist to DB.
 */
export async function saveSprint({
  chatId,
  userId,
  memwalKey,
}: {
  chatId: string;
  userId: string;
  memwalKey: string;
}): Promise<SaveSprintResult> {
  console.log(`[sprint:save] Starting sprint save for chat=${chatId}`);

  // 1. Verify chat ownership
  const chat = await getChatById({ id: chatId });
  if (!chat) {
    throw new ChatbotError("not_found:chat", "Chat not found");
  }
  if (chat.userId !== userId) {
    throw new ChatbotError("forbidden:chat", "Chat belongs to another user");
  }

  // 2. Check 1-sprint-per-chat limit
  const existing = await getSprintByChatId({ chatId });
  if (existing) {
    throw new ChatbotError(
      "bad_request:api",
      "This chat already has a saved sprint"
    );
  }

  // 3. Generate report
  console.log("[sprint:save] Generating report...");
  const report = await generateSprintReport({ chatId, userId });
  console.log(`[sprint:save] Report generated: "${report.title}"`);

  // 4. Build source metadata from citations (deduplicate by sourceId, then by title)
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
  // Further deduplicate by title — same source may have different IDs across sessions
  const seenTitles = new Set<string>();
  const sources: SourceMeta[] = [];
  for (const s of sourceMap.values()) {
    const key = s.title?.toLowerCase() ?? s.sourceId;
    if (!seenTitles.has(key)) {
      seenTitles.add(key);
      sources.push(s);
    }
  }

  // 5. Store in MemWal
  console.log("[sprint:save] Storing in MemWal...");
  const memwalResult = await rememberSprintReport({
    key: memwalKey,
    title: report.title,
    content: report.content,
    citations: report.citations,
    sources,
  });
  console.log(
    `[sprint:save] MemWal stored. blobId=${memwalResult.blobId}`
  );

  // 6. Save to DB
  console.log("[sprint:save] Saving to DB...");
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

  console.log(
    `[sprint:save] Sprint saved! id=${sprintRecord.id}, blobId=${memwalResult.blobId}`
  );

  return {
    sprintId: sprintRecord.id,
    title: report.title,
    blobId: memwalResult.blobId,
  };
}
