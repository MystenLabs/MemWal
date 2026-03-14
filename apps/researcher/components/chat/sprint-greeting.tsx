"use client";

import { motion } from "framer-motion";
import {
  BookOpenIcon,
  FileTextIcon,
  GlobeIcon,
  HashIcon,
  LayersIcon,
  SparklesIcon,
} from "lucide-react";
import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type SprintSummary = {
  id: string;
  title: string;
  summary: string | null;
  tags: string[] | null;
  sources: Array<{
    sourceId: string;
    title: string | null;
    url: string | null;
    type: "url" | "pdf";
  }> | null;
  memoryCount: number | null;
};

function SprintCard({
  sprint,
  index,
  isMulti,
}: {
  sprint: SprintSummary;
  index: number;
  isMulti: boolean;
}) {
  const sourceCount = sprint.sources?.length ?? 0;
  const uniqueSources = sprint.sources
    ? [...new Map(sprint.sources.map((s) => [s.sourceId, s])).values()]
    : [];

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "rounded-xl border border-border/40 bg-gradient-to-br from-muted/50 via-background to-muted/30 p-4 shadow-sm backdrop-blur-sm",
        isMulti && "border-l-2 border-l-primary/30"
      )}
      initial={{ opacity: 0, y: 12 }}
      transition={{ delay: 0.3 + index * 0.1, duration: 0.4, ease: "easeOut" }}
    >
      {/* Title */}
      <div className="flex items-start gap-2">
        <BookOpenIcon className="mt-0.5 size-4 shrink-0 text-primary/70" />
        <h3 className="font-semibold text-sm leading-snug text-foreground">
          {sprint.title}
        </h3>
      </div>

      {/* Summary */}
      {sprint.summary && (
        <p className="mt-2 line-clamp-3 pl-6 text-[13px] leading-relaxed text-muted-foreground">
          {sprint.summary}
        </p>
      )}

      {/* Tags */}
      {sprint.tags && sprint.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 pl-6">
          {sprint.tags.slice(0, 6).map((tag) => (
            <Badge
              className="gap-1 border-border/50 bg-background/80 px-2 py-0 font-normal text-[10px] text-muted-foreground"
              key={tag}
              variant="outline"
            >
              <HashIcon className="size-2.5" />
              {tag}
            </Badge>
          ))}
          {sprint.tags.length > 6 && (
            <span className="self-center text-[10px] text-muted-foreground/60">
              +{sprint.tags.length - 6} more
            </span>
          )}
        </div>
      )}

      {/* Sources */}
      {uniqueSources.length > 0 && (
        <div className="mt-3 flex items-center gap-3 pl-6 text-[11px] text-muted-foreground/70">
          <span className="flex items-center gap-1">
            <LayersIcon className="size-3" />
            {sourceCount} source{sourceCount !== 1 ? "s" : ""}
          </span>
          <span className="text-border">·</span>
          <span className="flex items-center gap-1.5 truncate">
            {uniqueSources.slice(0, 3).map((source) => (
              <span className="flex items-center gap-0.5" key={source.sourceId}>
                {source.type === "url" ? (
                  <GlobeIcon className="size-2.5" />
                ) : (
                  <FileTextIcon className="size-2.5" />
                )}
                <span className="max-w-[120px] truncate">
                  {source.title || "Untitled"}
                </span>
              </span>
            ))}
            {uniqueSources.length > 3 && (
              <span>+{uniqueSources.length - 3}</span>
            )}
          </span>
        </div>
      )}

      {/* Memory count */}
      {sprint.memoryCount != null && sprint.memoryCount > 0 && (
        <div className="mt-2 flex items-center gap-1 pl-6 text-[11px] text-muted-foreground/60">
          <SparklesIcon className="size-2.5" />
          {sprint.memoryCount} memor{sprint.memoryCount !== 1 ? "ies" : "y"} stored
        </div>
      )}
    </motion.div>
  );
}

function PureSprintGreeting({
  sprints,
  greeting,
  isLoading,
}: {
  sprints: SprintSummary[];
  greeting?: string;
  isLoading?: boolean;
}) {
  const isMulti = sprints.length > 1;

  return (
    <div
      className="mx-auto flex size-full max-w-3xl flex-col gap-4 px-4 pt-4 md:px-8 md:pt-8"
      key="sprint-greeting"
    >
      {/* LLM greeting */}
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-1"
        initial={{ opacity: 0, y: 10 }}
        transition={{ delay: 0.15 }}
      >
        {isLoading ? (
          <div className="flex flex-col gap-2">
            <div className="h-6 w-3/4 animate-pulse rounded-md bg-muted/60" />
            <div className="h-5 w-1/2 animate-pulse rounded-md bg-muted/40" />
          </div>
        ) : greeting ? (
          <p className="text-base leading-relaxed text-foreground/90 md:text-lg">
            {greeting}
          </p>
        ) : (
          <p className="text-base leading-relaxed text-foreground/90 md:text-lg">
            {isMulti
              ? `I've got context on ${sprints.length} research sprints — ask me anything.`
              : "I've reviewed your research — ask me anything."}
          </p>
        )}
      </motion.div>

      {/* Sprint cards */}
      <div className={cn("flex flex-col gap-3", isMulti && "gap-2")}>
        {sprints.map((sprint, index) => (
          <SprintCard
            index={index}
            isMulti={isMulti}
            key={sprint.id}
            sprint={sprint}
          />
        ))}
      </div>
    </div>
  );
}

export const SprintGreeting = memo(PureSprintGreeting);
SprintGreeting.displayName = "SprintGreeting";
