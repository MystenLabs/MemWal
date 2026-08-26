import "server-only";

import { MemWal, MemWalMock } from "@mysten-incubation/memwal";
import type { RememberResult } from "@mysten-incubation/memwal";
import { isTestEnvironment } from "@/lib/constants";
import type { Citation, SourceMeta } from "./types";

// One mock per account, mirroring the real client's per-(key, accountId)
// construction: a sprint remembered by one identity must not be recallable by
// another. Held across requests so remember → recall round-trips within a run,
// and so test runs can never write to the real relayer in MEMWAL_SERVER_URL.
const testMemWalClients = new Map<string, MemWalMock>();

function getMemWalClient(key: string, accountId: string): MemWal | MemWalMock {
  if (isTestEnvironment) {
    const existing = testMemWalClients.get(accountId);
    if (existing) return existing;

    const created = MemWalMock.create({ owner: accountId });
    testMemWalClients.set(accountId, created);
    return created;
  }
  return MemWal.create({
    key,
    accountId,
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
  accountId: string;
  title: string;
  content: string;
  citations: Citation[];
  sources: SourceMeta[];
}): Promise<RememberResult> {
  const memwal = getMemWalClient(key, accountId);

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
  const result = await memwal.rememberAndWait(fullText);
  console.log(`[sprint:memwal] Stored. blobId=${result.blob_id}`);
  return result;
}

export async function recallFromMemWal(
  key: string,
  query: string,
  limit: number = 5,
  accountId: string
) {
  const memwal = getMemWalClient(key, accountId);
  const { results } = await memwal.recall(query, limit);
  return results.map((r) => ({
    text: r.text,
    relevance: 1 - r.distance,
  }));
}
