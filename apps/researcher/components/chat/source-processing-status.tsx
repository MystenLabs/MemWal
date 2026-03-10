"use client";

import {
  CheckCircleIcon,
  ChevronDownIcon,
  FileTextIcon,
  GlobeIcon,
  LinkIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";

// --- Types ---

type SourceEvent =
  | { type: "processing"; label: string }
  | {
      type: "processed";
      label: string;
      title: string;
      chunkCount: number;
      sourceId: string;
    }
  | { type: "error"; label: string; error: string }
  | { type: "done"; count: number };

type SourceProcessingContextValue = {
  events: SourceEvent[];
  pushEvent: (event: SourceEvent) => void;
  clear: () => void;
};

const SourceProcessingContext =
  createContext<SourceProcessingContextValue | null>(null);

// --- Provider ---

export function SourceProcessingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [events, setEvents] = useState<SourceEvent[]>([]);

  const pushEvent = useCallback((event: SourceEvent) => {
    setEvents((prev) => [...prev, event]);
  }, []);

  const clear = useCallback(() => {
    setEvents([]);
  }, []);

  const value = useMemo(
    () => ({ events, pushEvent, clear }),
    [events, pushEvent, clear]
  );

  return (
    <SourceProcessingContext.Provider value={value}>
      {children}
    </SourceProcessingContext.Provider>
  );
}

export function useSourceProcessing() {
  const context = useContext(SourceProcessingContext);
  if (!context) {
    throw new Error(
      "useSourceProcessing must be used within SourceProcessingProvider"
    );
  }
  return context;
}

// --- Helpers ---

function isUrlLabel(label: string) {
  return label.startsWith("http://") || label.startsWith("https://");
}

function truncateLabel(label: string, max = 48) {
  if (label.length <= max) return label;
  return `${label.slice(0, max)}...`;
}

// --- Status Component ---

export function SourceProcessingStatus() {
  const { events } = useSourceProcessing();
  const [isOpen, setIsOpen] = useState(false);

  const processingEvents = events.filter((e) => e.type === "processing");
  const processedEvents = events.filter((e) => e.type === "processed");
  const errorEvents = events.filter((e) => e.type === "error");
  const doneEvents = events.filter((e) => e.type === "done");

  if (processingEvents.length === 0) return null;

  const isDone = doneEvents.length > 0;
  const totalSources = processingEvents.length;
  const completedCount = processedEvents.length + errorEvents.length;
  const isStillProcessing = !isDone;

  // Build the compact summary line
  const summaryText = (() => {
    if (isDone) {
      const count = doneEvents[0].count;
      return `${count} source${count !== 1 ? "s" : ""} processed`;
    }
    if (totalSources === 1) {
      return "Processing source";
    }
    return `Processing sources (${completedCount}/${totalSources})`;
  })();

  return (
    <Collapsible
      className="not-prose"
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      {/* Compact trigger — single line */}
      <CollapsibleTrigger
        className={cn(
          "group flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors hover:bg-muted",
          isDone
            ? "text-muted-foreground"
            : "text-foreground"
        )}
      >
        {isStillProcessing ? (
          <LoaderIcon className="size-3.5 animate-spin text-primary" />
        ) : (
          <LinkIcon className="size-3.5 text-primary" />
        )}

        {isStillProcessing ? (
          <Shimmer duration={1.5}>{summaryText}</Shimmer>
        ) : (
          <span className="font-medium">{summaryText}</span>
        )}

        <ChevronDownIcon
          className={cn(
            "size-3 text-muted-foreground transition-transform",
            isOpen && "rotate-180"
          )}
        />
      </CollapsibleTrigger>

      {/* Expanded detail list */}
      <CollapsibleContent
        className={cn(
          "mt-1",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2",
          "data-[state=open]:slide-in-from-top-2",
          "outline-none data-[state=closed]:animate-out data-[state=open]:animate-in"
        )}
      >
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/50 bg-muted/30 px-3 py-2">
          {processingEvents.map((event, i) => {
            const label = event.label;
            const isUrl = isUrlLabel(label);
            const errorEvent = errorEvents.find((ee) => ee.label === label);

            // Error state
            if (errorEvent) {
              return (
                <SourceRow
                  key={`source-${i}`}
                  icon={
                    <XCircleIcon className="size-3.5 shrink-0 text-red-500" />
                  }
                  label={truncateLabel(label)}
                  isUrl={isUrl}
                  detail={
                    <span className="text-red-500/80">
                      {errorEvent.error}
                    </span>
                  }
                />
              );
            }

            // Completed state
            if (i < processedEvents.length) {
              const processed = processedEvents[i];
              return (
                <SourceRow
                  key={`source-${i}`}
                  icon={
                    <CheckCircleIcon className="size-3.5 shrink-0 text-green-500" />
                  }
                  label={processed.title || truncateLabel(label)}
                  isUrl={isUrl}
                  detail={
                    <span className="text-muted-foreground">
                      {processed.chunkCount} chunk
                      {processed.chunkCount !== 1 ? "s" : ""}
                    </span>
                  }
                />
              );
            }

            // In-progress state
            return (
              <SourceRow
                key={`source-${i}`}
                icon={
                  <LoaderIcon className="size-3.5 shrink-0 animate-spin text-primary" />
                }
                label={truncateLabel(label)}
                isUrl={isUrl}
              />
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// --- Row sub-component ---

function SourceRow({
  icon,
  label,
  isUrl,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  isUrl: boolean;
  detail?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[11px]">
      {icon}
      <span className="flex items-center gap-1.5 truncate text-foreground/80">
        {isUrl ? (
          <GlobeIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <FileTextIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        {label}
      </span>
      {detail && (
        <>
          <span className="text-border">·</span>
          <span className="shrink-0 text-[10px]">{detail}</span>
        </>
      )}
    </div>
  );
}
