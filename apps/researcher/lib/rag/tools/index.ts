import { listSourcesTool } from "./list-sources";
import { searchSourceContentTool } from "./search-content";
import { getChunkContentTool } from "./get-chunks";
import { getSourceContextTool } from "./get-context";
import { recallSprintTool } from "./recall-sprint";

// Base tools always returned
const BASE_TOOL_NAMES = [
  "listSources",
  "searchSourceContent",
  "getChunkContent",
  "getSourceContext",
] as const;

// All tool names including optional ones
const ALL_TOOL_NAMES = [...BASE_TOOL_NAMES, "recallSprint"] as const;

export type ResearchToolName = (typeof ALL_TOOL_NAMES)[number];

export function getResearchTools({
  userId,
  memwalKey,
}: {
  userId: string;
  memwalKey?: string;
}) {
  const tools: Record<string, any> = {
    listSources: listSourcesTool({ userId }),
    searchSourceContent: searchSourceContentTool({ userId }),
    getChunkContent: getChunkContentTool({ userId }),
    getSourceContext: getSourceContextTool({ userId }),
  };

  if (memwalKey) {
    tools.recallSprint = recallSprintTool({ memwalKey });
  }

  return tools;
}
