"use client";

import {
  BookOpenIcon,
  BrainIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  FileTextIcon,
  GlobeIcon,
  ListIcon,
  LoaderIcon,
  SearchIcon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import type { ActivityStep, ResearchActivity as ResearchActivityType } from "@/hooks/use-research-activity";

// --- Icon resolver ---

const ICON_MAP: Record<string, typeof SearchIcon> = {
  search: SearchIcon,
  list: ListIcon,
  "file-text": FileTextIcon,
  "book-open": BookOpenIcon,
  brain: BrainIcon,
  globe: GlobeIcon,
  sparkles: SparklesIcon,
  circle: CircleIcon,
};

function getIcon(iconName: string) {
  return ICON_MAP[iconName] ?? CircleIcon;
}

// --- Step row ---

const ActivityStepRow = memo(({ step }: { step: ActivityStep }) => {
  const Icon = getIcon(step.iconName);

  const statusIcon = (() => {
    switch (step.status) {
      case "active":
        return <LoaderIcon className="size-3.5 shrink-0 animate-spin text-primary" />;
      case "complete":
        return <CheckCircleIcon className="size-3.5 shrink-0 text-green-500" />;
      case "error":
        return <XCircleIcon className="size-3.5 shrink-0 text-red-500" />;
      case "pending":
      default:
        return <CircleIcon className="size-3.5 shrink-0 text-muted-foreground/50" />;
    }
  })();

  return (
    <div className="flex items-center gap-2 py-0.5 text-[11px] fade-in-0 slide-in-from-top-2 animate-in">
      {statusIcon}
      <span className="flex items-center gap-1.5 truncate text-foreground/80">
        <Icon className="size-3 shrink-0 text-muted-foreground" />
        {step.label}
      </span>
      {step.detail && (
        <>
          <span className="text-border">·</span>
          <span className={cn(
            "shrink-0 text-[10px]",
            step.status === "error" ? "text-red-500/80" : "text-muted-foreground"
          )}>
            {step.detail}
          </span>
        </>
      )}
    </div>
  );
});
ActivityStepRow.displayName = "ActivityStepRow";

// --- Main component ---

const AUTO_CLOSE_DELAY = 1000;

function PureResearchActivity({ activity }: { activity: ResearchActivityType }) {
  const { steps, isActive, isComplete, elapsedSeconds } = activity;

  const [isOpen, setIsOpen] = useState(true);
  const [hasAutoClosed, setHasAutoClosed] = useState(false);
  const userClosedRef = useRef(false);

  // Auto-collapse when complete
  useEffect(() => {
    if (isComplete && isOpen && !hasAutoClosed && !userClosedRef.current) {
      const timer = setTimeout(() => {
        setIsOpen(false);
        setHasAutoClosed(true);
      }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
  }, [isComplete, isOpen, hasAutoClosed]);

  // Reset state on new activity
  useEffect(() => {
    if (isActive && steps.length <= 1) {
      setIsOpen(true);
      setHasAutoClosed(false);
      userClosedRef.current = false;
    }
  }, [isActive, steps.length]);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (!open && isActive) {
      userClosedRef.current = true;
    }
  };

  if (steps.length === 0) return null;

  return (
    <div className="not-prose mb-2">
      <Collapsible open={isOpen} onOpenChange={handleOpenChange}>
        <CollapsibleTrigger
          className={cn(
            "group flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-muted",
            isActive ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {isActive ? (
            <LoaderIcon className="size-3.5 animate-spin text-primary" />
          ) : (
            <SearchIcon className="size-3.5 text-primary" />
          )}

          {isActive ? (
            <Shimmer duration={1.5}>Researching</Shimmer>
          ) : (
            <span className="font-medium">
              Research · {elapsedSeconds}s
            </span>
          )}

          <ChevronDownIcon
            className={cn(
              "size-3 text-muted-foreground transition-transform",
              isOpen && "rotate-180"
            )}
          />
        </CollapsibleTrigger>

        <CollapsibleContent
          className={cn(
            "mt-1",
            "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2",
            "data-[state=open]:slide-in-from-top-2",
            "outline-none data-[state=closed]:animate-out data-[state=open]:animate-in"
          )}
        >
          <div className="flex flex-col gap-0.5 rounded-lg border border-border/50 bg-muted/30 px-3 py-2">
            {steps.map((step) => (
              <ActivityStepRow key={step.id} step={step} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export const ResearchActivity = memo(PureResearchActivity);
ResearchActivity.displayName = "ResearchActivity";
