/**
 * Builds the exportable markdown for a saved sprint. Shared by the panel's
 * Copy and Download actions so clipboard and file output are identical.
 * Pure so it can be unit-tested without the React layer.
 */

type ExportableCitation = {
  refIndex: number;
  sourceTitle: string;
  sourceUrl: string | null;
  section: string;
};

export type ExportableSprint = {
  title: string;
  summary?: string | null;
  reportContent?: string | null;
  createdAt: string;
  citations?: ExportableCitation[] | null;
};

export function buildSprintMarkdown(sprint: ExportableSprint): string {
  const sections: string[] = [`# ${sprint.title}`];

  if (sprint.summary) {
    sections.push(sprint.summary);
  }

  if (sprint.reportContent) {
    sections.push(sprint.reportContent);
  }

  const citations = sprint.citations ?? [];
  if (citations.length > 0) {
    const refs = citations
      .map((c) => {
        const base = `[${c.refIndex}] ${c.sourceTitle} — ${c.section}`;
        return c.sourceUrl ? `${base} (${c.sourceUrl})` : base;
      })
      .join("\n");
    sections.push(`## References\n\n${refs}`);
  }

  return `${sections.join("\n\n")}\n`;
}

/** Slug the sprint title into a filesystem-safe markdown file name. */
export function sprintFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "sprint-report"}.md`;
}
