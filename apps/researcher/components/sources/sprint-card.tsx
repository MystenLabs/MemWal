"use client";

import {
  BookmarkIcon,
  ChevronRightIcon,
  CalendarIcon,
  FileTextIcon,
  LinkIcon,
  HashIcon,
  BrainIcon,
} from "lucide-react";
import { memo } from "react";
import type { SprintListItem } from "@/hooks/use-sprints";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function PureSprintCard({
  sprint,
  onClick,
}: {
  sprint: SprintListItem;
  onClick: () => void;
}) {
  const sourceCount = sprint.sources?.length ?? 0;
  const citationCount = sprint.citations?.length ?? 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
        <BookmarkIcon className="size-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{sprint.title}</p>
        {sprint.summary && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {sprint.summary}
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <CalendarIcon className="size-3" />
            {formatDate(sprint.createdAt)}
          </span>
          {sourceCount > 0 && (
            <>
              <span>·</span>
              <span>
                {sourceCount} source{sourceCount !== 1 ? "s" : ""}
              </span>
            </>
          )}
          {citationCount > 0 && (
            <>
              <span>·</span>
              <span>
                {citationCount} ref{citationCount !== 1 ? "s" : ""}
              </span>
            </>
          )}
        </div>
      </div>
      <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

export const SprintCard = memo(PureSprintCard);
