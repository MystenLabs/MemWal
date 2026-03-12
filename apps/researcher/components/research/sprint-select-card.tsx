"use client";

import { CheckIcon, FileTextIcon } from "lucide-react";
import { memo } from "react";
import type { SprintListItem } from "@/hooks/use-sprints";
import { cn } from "@/lib/utils";

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function PureSprintSelectCard({
  sprint,
  isSelected,
  isPreviewing,
  onToggleSelect,
  onPreview,
}: {
  sprint: SprintListItem;
  isSelected: boolean;
  isPreviewing: boolean;
  onToggleSelect: () => void;
  onPreview: () => void;
}) {
  const sourceCount = sprint.sources?.length ?? 0;

  return (
    <div
      className={cn(
        "group relative flex cursor-pointer gap-3 rounded-lg border p-3 transition-all",
        isSelected
          ? "border-primary/50 bg-primary/5"
          : "border-border hover:border-muted-foreground/30",
        isPreviewing && "ring-2 ring-primary/30"
      )}
      onClick={onPreview}
    >
      {/* Checkbox */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
          isSelected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40 hover:border-primary"
        )}
      >
        {isSelected && <CheckIcon className="size-3" />}
      </button>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-medium">{sprint.title}</h3>
        {sprint.summary && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {sprint.summary}
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{formatDate(sprint.createdAt)}</span>
          {sourceCount > 0 && (
            <span className="flex items-center gap-1">
              <FileTextIcon className="size-3" />
              {sourceCount}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export const SprintSelectCard = memo(PureSprintSelectCard);
