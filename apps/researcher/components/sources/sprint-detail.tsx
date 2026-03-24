"use client";

import {
  ArrowLeftIcon,
  BookmarkIcon,
  CalendarIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HashIcon,
  LinkIcon,
  BrainIcon,
} from "lucide-react";
import { memo, useState } from "react";
import { Response } from "@/components/elements/response";
import type { SprintListItem } from "@/hooks/use-sprints";
import { cn } from "@/lib/utils";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PureSprintDetail({
  sprint,
  onBack,
}: {
  sprint: SprintListItem;
  onBack: () => void;
}) {
  const [activeSection, setActiveSection] = useState<
    "report" | "citations" | "sources"
  >("report");

  const citations = sprint.citations ?? [];

  // Deduplicate sources by title (same source may have different IDs across sessions)
  const rawSources = sprint.sources ?? [];
  const sources = rawSources.filter((s, i, arr) =>
    arr.findIndex((o) => (o.title ?? o.sourceId) === (s.title ?? s.sourceId)) === i
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header with back button */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{sprint.title}</h2>
          <p className="text-xs text-muted-foreground">
            {formatDate(sprint.createdAt)}
          </p>
        </div>
      </div>

      {/* Summary card */}
      <div className="border-b px-4 py-3">
        {sprint.summary && (
          <p className="text-sm text-muted-foreground">{sprint.summary}</p>
        )}
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <FileTextIcon className="size-3" />
            {sources.length} source{sources.length !== 1 ? "s" : ""}
          </span>
          <span className="flex items-center gap-1">
            <HashIcon className="size-3" />
            {citations.length} citation{citations.length !== 1 ? "s" : ""}
          </span>
          {sprint.memoryCount != null && sprint.memoryCount > 0 && (
            <span className="flex items-center gap-1">
              <BrainIcon className="size-3" />
              Saved to MemWal
            </span>
          )}
        </div>
        {sprint.tags && sprint.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {[...new Set(sprint.tags)].map((tag) => (
              <span
                key={tag}
                className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Section tabs */}
      <div className="flex border-b px-4">
        {(
          [
            { key: "report", label: "Report" },
            { key: "citations", label: `Citations (${citations.length})` },
            { key: "sources", label: `Sources (${sources.length})` },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveSection(tab.key)}
            className={cn(
              "border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              activeSection === tab.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeSection === "report" && (
          <div className="p-4">
            {sprint.reportContent ? (
              <div className="prose-sm">
                <Response>{sprint.reportContent}</Response>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No report content available.
              </p>
            )}
          </div>
        )}

        {activeSection === "citations" && (
          <div className="space-y-3 p-4">
            {citations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No citations recorded.
              </p>
            ) : (
              citations.map((c) => (
                <div
                  key={c.refIndex}
                  className="rounded-lg border p-3"
                >
                  <div className="flex items-start gap-2">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 text-xs font-semibold text-primary">
                      {c.refIndex}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{c.sourceTitle}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {c.section}
                      </p>
                      {c.scope && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {c.scope}
                        </p>
                      )}
                      {c.sourceUrl && (
                        <a
                          href={c.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <ExternalLinkIcon className="size-3" />
                          <span className="truncate">{c.sourceUrl}</span>
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeSection === "sources" && (
          <div className="space-y-3 p-4">
            {sources.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No sources recorded.
              </p>
            ) : (
              sources.map((s) => (
                <div
                  key={s.sourceId}
                  className="flex items-start gap-3 rounded-lg border p-3"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    {s.type === "pdf" ? (
                      <FileTextIcon className="size-4 text-muted-foreground" />
                    ) : (
                      <LinkIcon className="size-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {s.title || "Untitled"}
                    </p>
                    {s.url && (
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <ExternalLinkIcon className="size-3" />
                        <span className="truncate">{s.url}</span>
                      </a>
                    )}
                    <p className="mt-0.5 text-xs uppercase text-muted-foreground">
                      {s.type}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const SprintDetail = memo(PureSprintDetail);
