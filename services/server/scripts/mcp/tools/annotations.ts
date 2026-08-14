import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

interface RemoteToolMetadata {
    title: string;
    annotations: ToolAnnotations;
}

/** Metadata surfaced to MCP clients through `tools/list`. */
export const TOOL_METADATA = {
    memwal_remember: {
        title: "Remember a Fact",
        annotations: { readOnlyHint: false, destructiveHint: false },
    },
    memwal_remember_bulk: {
        title: "Remember Multiple Facts",
        annotations: { readOnlyHint: false, destructiveHint: false },
    },
    memwal_analyze: {
        title: "Analyze and Remember",
        annotations: { readOnlyHint: false, destructiveHint: false },
    },
    memwal_restore: {
        title: "Restore Memory Index",
        annotations: { readOnlyHint: false, destructiveHint: false },
    },
    memwal_recall: {
        title: "Recall Memories",
        annotations: { readOnlyHint: true, destructiveHint: false },
    },
    memwal_health: {
        title: "Check Walrus Memory Health",
        annotations: { readOnlyHint: true, destructiveHint: false },
    },
} as const satisfies Record<string, RemoteToolMetadata>;
