import "server-only";

import { MemWal } from "@cmdoss/memwal";
import type { RememberResult } from "@cmdoss/memwal";
import type { Citation, SourceMeta } from "./types";

function getMemWalClient(key: string) {
  return MemWal.create({
    key,
    serverUrl: process.env.MEMWAL_SERVER_URL,
  });
}

export async function rememberSprintReport({
  key,
  accountId,
  title,
  content,
  citations,
  sources,
}: {
  key: string;
  accountId?: string;
  title: string;
  content: string;
  citations: Citation[];
  sources: SourceMeta[];
}): Promise<RememberResult> {
  const memwal = getMemWalClient(key);

  const references = citations
    .map(
      (c) =>
        `[${c.refIndex}] ${c.sourceTitle} — ${c.section} (${c.sourceUrl ?? "no url"})`
    )
    .join("\n");

  const sourceList = sources
    .map((s) => `${s.title ?? "Untitled"} (${s.url ?? "no url"})`)
    .join(", ");

  const fullText =
    `Sprint Report: ${title}\n\n` +
    `${content}\n\n` +
    `References:\n${references}\n\n` +
    `Sources: ${sourceList}`;

  console.log(
    `[sprint:memwal] Storing sprint report (${fullText.length} chars)`
  );
  const result = await memwal.remember(fullText);
  console.log(`[sprint:memwal] Stored. blobId=${result.blob_id}`);
  return result;
}

export async function recallFromMemWal(
  key: string,
  query: string,
  limit: number = 5,
  accountId?: string
) {
  const memwal = getMemWalClient(key);
  const { results } = await memwal.recall(query, limit);
  return results.map((r) => ({
    text: r.text,
    relevance: 1 - r.distance,
  }));
}
