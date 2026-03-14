"use client";

import { useCallback, useRef, useState } from "react";

export type SaveStep = {
  id: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  message?: string;
};

export type SprintSaveState = {
  phase: "idle" | "saving" | "done" | "error";
  steps: SaveStep[];
  progress: number;
  result: { title: string; sprintId: string } | null;
  error: string | null;
};

const INITIAL_STEPS: SaveStep[] = [
  { id: "verify", label: "Verifying chat", status: "pending" },
  { id: "check-duplicate", label: "Checking existing sprint", status: "pending" },
  { id: "generate-report", label: "Generating report", status: "pending" },
  { id: "build-sources", label: "Processing sources", status: "pending" },
  { id: "store-memwal", label: "Storing in MemWal", status: "pending" },
  { id: "save-db", label: "Saving to database", status: "pending" },
];

// Progress weights: verify(5) + check-duplicate(5) + generate-report(50) + build-sources(10) + store-memwal(20) + save-db(10) = 100
const STEP_WEIGHTS: Record<string, number> = {
  "verify": 5,
  "check-duplicate": 5,
  "generate-report": 50,
  "build-sources": 10,
  "store-memwal": 20,
  "save-db": 10,
};

function calcProgress(steps: SaveStep[]): number {
  let progress = 0;
  for (const step of steps) {
    if (step.status === "done") {
      progress += STEP_WEIGHTS[step.id] ?? 0;
    } else if (step.status === "active") {
      // Show partial progress for active step
      progress += (STEP_WEIGHTS[step.id] ?? 0) * 0.1;
    }
  }
  return Math.min(Math.round(progress), 100);
}

export function useSprintSave() {
  const [state, setState] = useState<SprintSaveState>({
    phase: "idle",
    steps: [],
    progress: 0,
    result: null,
    error: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const lastChatIdRef = useRef<string | null>(null);

  const save = useCallback((chatId: string) => {
    lastChatIdRef.current = chatId;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setState({
      phase: "saving",
      steps: INITIAL_STEPS.map((s) => ({ ...s })),
      progress: 0,
      result: null,
      error: null,
    });

    (async () => {
      try {
        const response = await fetch("/api/sprint/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId }),
          signal: abort.signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          setState((prev) => ({
            ...prev,
            phase: "error",
            error: errorData.message ?? `Server error: ${response.status}`,
          }));
          return;
        }

        if (!response.body) {
          setState((prev) => ({
            ...prev,
            phase: "error",
            error: "No response stream",
          }));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.trim()) continue;

            let eventType = "message";
            let dataStr = "";

            for (const line of part.split("\n")) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                dataStr = line.slice(6);
              }
            }

            if (!dataStr) continue;

            let data: Record<string, any>;
            try {
              data = JSON.parse(dataStr);
            } catch {
              continue;
            }

            setState((prev) => {
              const next = { ...prev };
              next.steps = [...prev.steps];

              if (eventType === "step") {
                const stepIdx = next.steps.findIndex((s) => s.id === data.step);
                if (stepIdx !== -1) {
                  const step = { ...next.steps[stepIdx] };
                  if (data.status === "start") {
                    step.status = "active";
                    step.message = data.message;
                  } else if (data.status === "done") {
                    step.status = "done";
                    step.message = data.message;
                  } else if (data.status === "error") {
                    step.status = "error";
                    step.message = data.message;
                  }
                  next.steps[stepIdx] = step;
                }
              } else if (eventType === "ready") {
                next.phase = "done";
                next.progress = 100;
                next.result = {
                  title: data.title,
                  sprintId: data.sprintId,
                };
                return next;
              } else if (eventType === "error") {
                next.phase = "error";
                next.error = data.message ?? "Failed to save sprint";
                return next;
              }

              next.progress = calcProgress(next.steps);
              return next;
            });
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState((prev) => ({
          ...prev,
          phase: "error",
          error: err instanceof Error ? err.message : "Connection failed",
        }));
      }
    })();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    lastChatIdRef.current = null;
    setState({
      phase: "idle",
      steps: [],
      progress: 0,
      result: null,
      error: null,
    });
  }, []);

  return { state, save, reset };
}
