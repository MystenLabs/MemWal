import { listSourcesTool } from "./list-sources";
import { searchSourceContentTool } from "./search-content";
import { getChunkContentTool } from "./get-chunks";
import { getSourceContextTool } from "./get-context";

export function getResearchTools({ userId }: { userId: string }) {
  return {
    listSources: listSourcesTool({ userId }),
    searchSourceContent: searchSourceContentTool({ userId }),
    getChunkContent: getChunkContentTool({ userId }),
    getSourceContext: getSourceContextTool({ userId }),
  };
}
