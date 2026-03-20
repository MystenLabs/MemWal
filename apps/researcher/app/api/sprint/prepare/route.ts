import { generateObject } from "ai";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { getLanguageModel } from "@/lib/ai/providers";
import { getSprintsByIds, saveChat, updateChatSprintContext } from "@/lib/db/queries";
import { recallFromMemWal } from "@/lib/sprint/memwal";
import { ChatbotError } from "@/lib/errors";

export const maxDuration = 60;

const QUERY_MODEL = "google/gemini-2.5-flash";

interface PrepareRequestBody {
  chatId: string;
  sprintIds: string[];
  visibility?: "public" | "private";
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const recallQueriesSchema = z.object({
  queries: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe("Semantic search queries to retrieve the full sprint content from memory"),
});

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  let body: PrepareRequestBody;
  try {
    body = await request.json();
    if (!body.chatId || !Array.isArray(body.sprintIds) || body.sprintIds.length === 0) {
      return new ChatbotError("bad_request:api").toResponse();
    }
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const { chatId, sprintIds, visibility = "private" } = body;
  const memwalKey = session.user.privateKey || process.env.MEMWAL_KEY;
  const memwalAccountId = session.user.accountId || process.env.MEMWAL_ACCOUNT_ID;
  const userId = session.user.id;

  if (!memwalKey) {
    return new ChatbotError("bad_request:api", "MemWal key is required for sprint preparation").toResponse();
  }

  console.log(`[sprint:prepare] memwalKey source=${session.user.privateKey ? "session" : "env"}, key=${memwalKey.slice(0, 8)}...`);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(sseEvent(event, data)));
      };

      try {
        // Step 1: Validate sprint ownership
        send("step", { step: "validate", status: "start", message: "Validating sprint access..." });
        console.log(`[sprint:prepare] Validating ${sprintIds.length} sprints for user=${userId.slice(0, 8)}...`);

        const ownedSprints = await getSprintsByIds({ sprintIds, userId });
        if (ownedSprints.length === 0) {
          console.log(`[sprint:prepare] No owned sprints found — aborting`);
          send("error", { step: "validate", message: "No valid sprints found. You may not have access to the selected sprints." });
          controller.close();
          return;
        }

        console.log(`[sprint:prepare] Validated ${ownedSprints.length} sprints: ${ownedSprints.map(s => `"${s.title}"`).join(", ")}`);
        send("step", {
          step: "validate",
          status: "done",
          message: "Access confirmed",
          detail: { sprintCount: ownedSprints.length },
        });

        // Step 2: Create chat record
        send("step", { step: "create-chat", status: "start", message: "Creating session..." });

        await saveChat({
          id: chatId,
          userId,
          title: "New chat",
          visibility,
          sprintIds: ownedSprints.map((s) => s.id),
        });

        console.log(`[sprint:prepare] Chat created: ${chatId}`);
        send("step", { step: "create-chat", status: "done", message: "Session created" });

        // Step 3: Per-sprint — LLM query generation → MemWal recall → context assembly
        send("step", { step: "build-context", status: "start", message: "Retrieving sprint research..." });

        const sprintContextBlocks: string[] = [];

        for (let i = 0; i < ownedSprints.length; i++) {
          const sprint = ownedSprints[i];
          const sourceNames = (sprint.sources ?? []).map((s) => s.title ?? "Untitled").join(", ");
          const tagList = sprint.tags?.length ? sprint.tags.join(", ") : "";

          // Phase A: Analyzing metadata
          send("sprint", {
            sprintIndex: i,
            sprintId: sprint.id,
            title: sprint.title,
            status: "analyzing",
            message: "Analyzing sprint metadata...",
          });

          console.log(`[sprint:prepare] Sprint[${i}] "${sprint.title}" — generating recall queries...`);
          console.log(`[sprint:prepare]   summary=${sprint.summary?.length ?? 0} chars, sources=${(sprint.sources ?? []).length}, tags=[${tagList}]`);

          // LLM generates semantic recall queries from metadata
          const { object: queryResult } = await generateObject({
            model: getLanguageModel(QUERY_MODEL),
            schema: recallQueriesSchema,
            prompt: `You are helping retrieve a research sprint report from semantic memory. Given the sprint metadata below, generate 3-5 diverse search queries that would retrieve the most comprehensive content from this sprint.

The queries should:
- Cover different aspects/topics of the sprint
- Use specific terms and concepts from the summary and tags
- Be phrased as semantic search queries (not questions)
- Together, aim to retrieve the sprint's full findings

Sprint metadata:
- Title: ${sprint.title}
- Summary: ${sprint.summary ?? "No summary available"}
- Sources: ${sourceNames || "No sources listed"}
- Tags: ${tagList || "No tags"}`,
          });

          console.log(`[sprint:prepare] Sprint[${i}] LLM generated ${queryResult.queries.length} queries: ${JSON.stringify(queryResult.queries)}`);

          // Phase B: Recalling from memory
          send("sprint", {
            sprintIndex: i,
            sprintId: sprint.id,
            title: sprint.title,
            status: "recalling",
            message: `Searching memory (${queryResult.queries.length} queries)...`,
          });

          // Execute all recall queries and deduplicate
          const seenTexts = new Set<string>();
          const allResults: { text: string; relevance: number }[] = [];

          for (const query of queryResult.queries) {
            try {
              console.log(`[sprint:prepare] Sprint[${i}] recall query="${query}"`);
              const results = await recallFromMemWal(memwalKey, query, 5, memwalAccountId);
              console.log(`[sprint:prepare] Sprint[${i}] recall returned ${results.length} results for "${query}"`);

              for (const r of results) {
                // Deduplicate by first 200 chars
                const key = r.text.slice(0, 200);
                if (!seenTexts.has(key)) {
                  seenTexts.add(key);
                  allResults.push(r);
                }
              }
            } catch (err) {
              console.warn(`[sprint:prepare] Sprint[${i}] recall failed for query="${query}":`, err);
            }
          }

          // Sort by relevance, filter out weak matches (unrelated sprints)
          allResults.sort((a, b) => b.relevance - a.relevance);

          const MIN_RELEVANCE = 0.4;
          const relevant = allResults.filter((r) => r.relevance >= MIN_RELEVANCE);
          const filtered = allResults.length - relevant.length;

          for (const [ri, r] of allResults.entries()) {
            const kept = r.relevance >= MIN_RELEVANCE ? "KEPT" : "filtered";
            console.log(`[sprint:prepare] Sprint[${i}] result[${ri}] relevance=${r.relevance.toFixed(3)} [${kept}], ${r.text.length} chars, preview="${r.text.slice(0, 80)}..."`);
          }

          const totalChars = relevant.reduce((sum, r) => sum + r.text.length, 0);
          console.log(`[sprint:prepare] Sprint[${i}] "${sprint.title}" — ${allResults.length} unique results, ${relevant.length} kept (${filtered} filtered below ${MIN_RELEVANCE}), ${totalChars} chars total`);

          // Assemble sprint context block
          const recalledContent = relevant
            .map((r) => r.text)
            .join("\n\n---\n\n");

          const block = [
            `### ${sprint.title}`,
            sprint.summary ? `**Summary:** ${sprint.summary}` : "",
            sourceNames ? `**Sources:** ${sourceNames}` : "",
            tagList ? `**Tags:** ${tagList}` : "",
            "",
            recalledContent
              ? `**Retrieved Research Findings:**\n\n${recalledContent}`
              : `*No findings retrieved from memory for this sprint.*`,
          ]
            .filter(Boolean)
            .join("\n");

          sprintContextBlocks.push(block);

          send("sprint", {
            sprintIndex: i,
            sprintId: sprint.id,
            title: sprint.title,
            status: "done",
            charCount: totalChars,
            resultCount: relevant.length,
            queryCount: queryResult.queries.length,
          });
        }

        // Assemble full sprint context
        const fullContext = [
          "## Previous Research Sprints",
          "",
          "The user has selected the following previous research sprints as context for this conversation.",
          "The findings below were retrieved from long-term research memory (MemWal).",
          "",
          ...sprintContextBlocks,
        ].join("\n");

        console.log(`[sprint:prepare] Full sprint context assembled: ${fullContext.length} chars`);

        send("step", { step: "build-context", status: "done", message: "Research retrieved" });

        // Step 4: Persist context to DB
        send("step", { step: "save-context", status: "start", message: "Saving context..." });

        await updateChatSprintContext({ chatId, sprintContext: fullContext });

        console.log(`[sprint:prepare] Sprint context persisted to chat ${chatId}`);
        send("step", { step: "save-context", status: "done", message: "Context saved" });

        // Step 5: Ready
        send("ready", {
          chatId,
          sprintCount: ownedSprints.length,
          contextChars: fullContext.length,
        });
        console.log(`[sprint:prepare] Preparation complete for chat ${chatId}`);
      } catch (err) {
        console.error("[sprint:prepare] Pipeline error:", err);
        send("error", {
          step: "unknown",
          message: err instanceof Error ? err.message : "Preparation failed",
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
