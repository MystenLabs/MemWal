export interface Citation {
  refIndex: number;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string | null;
  section: string;
  supportingChunks: string[]; // chunkIds
  scope: string; // what this citation covers
}

export interface SourceMeta {
  sourceId: string;
  title: string | null;
  url: string | null;
  type: "url" | "pdf";
}

export interface ManifestEntry {
  chunkId: string;
  sourceId: string;
  sourceTitle: string | null;
  sourceUrl: string | null;
  section: string;
  chunkIndex: number;
  preview: string; // first ~200 chars
}

export interface SprintReport {
  title: string;
  summary: string;
  content: string; // markdown with [N] citations
  citations: Citation[];
}

export interface SaveSprintResult {
  sprintId: string;
  title: string;
  blobId: string;
}
