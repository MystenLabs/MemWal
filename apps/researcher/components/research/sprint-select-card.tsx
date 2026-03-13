"use client";

import { CheckIcon, DatabaseIcon, FileTextIcon, TagIcon } from "lucide-react";
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
  const tags = sprint.tags ?? [];

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

        {/* Tags */}
        {tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {tags.slice(0, 4).map((tag, idx) => (
              <span
                key={`${idx}-${tag}`}
                className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                <TagIcon className="size-2" />
                {tag.length > 20 ? `${tag.slice(0, 20)}...` : tag}
              </span>
            ))}
            {tags.length > 4 && (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                +{tags.length - 4}
              </span>
            )}
          </div>
        )}

        {/* Meta row */}
        <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{formatDate(sprint.createdAt)}</span>
          {sourceCount > 0 && (
            <span className="flex items-center gap-1">
              <FileTextIcon className="size-3" />
              {sourceCount} source{sourceCount !== 1 ? "s" : ""}
            </span>
          )}
          {(sprint.memoryCount ?? 0) > 0 && (
            <span className="flex items-center gap-1">
              <DatabaseIcon className="size-3" />
              {sprint.memoryCount} memory
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export const SprintSelectCard = memo(PureSprintSelectCard);
