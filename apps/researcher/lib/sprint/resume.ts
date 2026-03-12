import "server-only";

import { getSprintsByIds } from "@/lib/db/queries";

/**
 * Builds a lightweight sprint briefing for the system prompt.
 *
 * Only metadata goes here (title, summary, source list, tags).
 * The full report content lives in MemWal and is retrieved on-demand
 * via the recallSprint tool.
 */
export async function buildSprintContext({
  sprintIds,
  userId,
}: {
  sprintIds: string[];
  userId: string;
}): Promise<{ systemPromptBlock: string; sprintCount: number }> {
  if (sprintIds.length === 0) {
    return { systemPromptBlock: "", sprintCount: 0 };
  }

  const sprints = await getSprintsByIds({ sprintIds, userId });

  console.log(`[sprint:resume] Requested ${sprintIds.length} sprints, found ${sprints.length} owned by user`);

  if (sprints.length === 0) {
    console.log(`[sprint:resume] No owned sprints found — skipping context injection`);
    return { systemPromptBlock: "", sprintCount: 0 };
  }

  const blocks = sprints.map((sprint) => {
    const sourceNames = (sprint.sources ?? [])
      .map((s) => s.title ?? "Untitled")
      .join(", ");

    const tagList = sprint.tags?.length ? sprint.tags.join(", ") : null;

    console.log(`[sprint:resume] Sprint "${sprint.title}" — summary=${sprint.summary?.length ?? 0} chars, sources=${(sprint.sources ?? []).length}, tags=${sprint.tags?.length ?? 0}`);

    return [
      `### ${sprint.title}`,
      sprint.summary ? `**Summary:** ${sprint.summary}` : "",
      sourceNames ? `**Sources:** ${sourceNames}` : "",
      tagList ? `**Tags:** ${tagList}` : "",
      "",
      `> Use **recallSprint** to retrieve detailed findings, data points, and citations from this sprint.`,
    ]
      .filter(Boolean)
      .join("\n");
  });

  const systemPromptBlock = [
    "## Previous Research Sprints",
    "",
    "The user has selected the following previous research sprints as context for this conversation.",
    "These are **metadata briefings only** — the full reports and detailed findings are stored in long-term memory (MemWal).",
    "You MUST use the **recallSprint** tool to retrieve specific content, quotes, data points, or citations from these sprints.",
    "",
    ...blocks,
  ].join("\n");

  return { systemPromptBlock, sprintCount: sprints.length };
}
