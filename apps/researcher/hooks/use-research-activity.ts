"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types";
import { useSourceProcessing } from "@/components/chat/source-processing-provider";

// --- Types ---

export type ActivityStepStatus = "pending" | "active" | "complete" | "error";

export type ActivityStep = {
  id: string;
  type: "thinking" | "tool" | "source";
  label: string;
  detail?: string;
  status: ActivityStepStatus;
  iconName: string;
};

export type ResearchActivity = {
  steps: ActivityStep[];
  isActive: boolean;
  isComplete: boolean;
  elapsedSeconds: number;
};

// --- Tool config ---

type ToolConfig = {
  label: string | ((input: Record<string, unknown>) => string);
  icon: string;
};

const TOOL_CONFIG: Record<string, ToolConfig> = {
  listSources: { label: "Scanning sources", icon: "list" },
  searchSourceContent: {
    label: (i) => `Searching: "${i?.query ?? ""}"`,
    icon: "search",
  },
  getChunkContent: { label: "Reading source content", icon: "file-text" },
  getSourceContext: { label: "Getting surrounding context", icon: "book-open" },
  recallSprint: {
    label: (i) => `Recalling: "${i?.query ?? ""}"`,
    icon: "brain",
  },
};

function resolveToolLabel(toolName: string, input: unknown): string {
  const config = TOOL_CONFIG[toolName];
  if (!config) return toolName;
  if (typeof config.label === "function") {
    return config.label((input as Record<string, unknown>) ?? {});
  }
  return config.label;
}

function resolveToolIcon(toolName: string): string {
  return TOOL_CONFIG[toolName]?.icon ?? "circle";
}

// Map AI SDK v4 tool part state → our step status
function mapToolState(state: string): ActivityStepStatus {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return "active";
    case "output-available":
      return "complete";
    case "output-error":
      return "error";
    default:
      return "active";
  }
}

// --- Hook ---

export function useResearchActivity(
  lastMessage: ChatMessage | undefined,
  status: string
): ResearchActivity {
  const { events: sourceEvents } = useSourceProcessing();

  // Elapsed time tracking
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derive steps from message parts + source events
  const steps = useMemo(() => {
    const result: ActivityStep[] = [];

    // 1. Thinking step
    const hasToolParts = lastMessage?.parts?.some((p) =>
      p.type.startsWith("tool-")
    );
    const hasTextParts = lastMessage?.parts?.some(
      (p) => p.type === "text" && (p as { text?: string }).text?.trim()
    );
    const hasContent = hasToolParts || hasTextParts;

    if (status === "submitted" || status === "streaming") {
      result.push({
        id: "thinking",
        type: "thinking",
        label: "Thinking",
        status: hasContent ? "complete" : "active",
        iconName: "sparkles",
      });
    }

    // 2. Tool steps from message parts
    if (lastMessage?.parts) {
      const seenToolIds = new Set<string>();

      for (let i = 0; i < lastMessage.parts.length; i++) {
        const part = lastMessage.parts[i] as {
          type: string;
          state?: string;
          toolCallId?: string;
          input?: unknown;
        };

        if (!part.type.startsWith("tool-")) continue;

        const toolName = part.type.slice(5);
        const stepId = part.toolCallId ?? `tool-${i}`;

        // Deduplicate: same toolCallId across re-renders stays one step
        if (seenToolIds.has(stepId)) continue;
        seenToolIds.add(stepId);

        result.push({
          id: stepId,
          type: "tool",
          label: resolveToolLabel(toolName, part.input),
          status: mapToolState(part.state ?? "input-available"),
          iconName: resolveToolIcon(toolName),
        });
      }
    }

    // 3. Source steps from SourceProcessing events
    const processingLabels = new Set<string>();

    for (const event of sourceEvents) {
      if (event.type === "processing") {
        processingLabels.add(event.label);
        const sourceId = `source-${event.label}`;

        // Check if already completed or errored
        const processed = sourceEvents.find(
          (e) => e.type === "processed" && e.label === event.label
        ) as
          | { type: "processed"; label: string; chunkCount: number }
          | undefined;
        const errored = sourceEvents.find(
          (e) => e.type === "error" && e.label === event.label
        ) as { type: "error"; label: string; error: string } | undefined;

        if (errored) {
          result.push({
            id: sourceId,
            type: "source",
            label: event.label,
            detail: errored.error,
            status: "error",
            iconName: "globe",
          });
        } else if (processed) {
          result.push({
            id: sourceId,
            type: "source",
            label: event.label,
            detail: `${processed.chunkCount} chunk${processed.chunkCount !== 1 ? "s" : ""}`,
            status: "complete",
            iconName: "globe",
          });
        } else {
          result.push({
            id: sourceId,
            type: "source",
            label: event.label,
            status: "active",
            iconName: "globe",
          });
        }
      }
    }

    return result;
  }, [lastMessage?.parts, sourceEvents, status]);

  const isActive = steps.some(
    (s) => s.status === "pending" || s.status === "active"
  );
  const isComplete =
    !isActive && steps.length > 0 && status === "ready";

  // Timer management
  useEffect(() => {
    if (steps.length > 0 && isActive && startTimeRef.current === null) {
      startTimeRef.current = Date.now();
      setElapsedSeconds(0);
      intervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setElapsedSeconds(
            Math.floor((Date.now() - startTimeRef.current) / 1000)
          );
        }
      }, 1000);
    }

    if (!isActive && startTimeRef.current !== null) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      // Final elapsed time
      if (startTimeRef.current) {
        setElapsedSeconds(
          Math.floor((Date.now() - startTimeRef.current) / 1000)
        );
      }
      startTimeRef.current = null;
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [steps.length, isActive]);

  // Reset on new request
  useEffect(() => {
    if (status === "submitted") {
      startTimeRef.current = null;
      setElapsedSeconds(0);
    }
  }, [status]);

  return { steps, isActive, isComplete, elapsedSeconds };
}
