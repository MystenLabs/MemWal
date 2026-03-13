"use client";

import { useCallback, useRef, useState } from "react";

export type PrepStep = {
  id: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  message?: string;
};

export type SprintProgress = {
  sprintId: string;
  title: string;
  status: "pending" | "analyzing" | "recalling" | "done";
  message?: string;
  charCount?: number;
  resultCount?: number;
};

export type PreparationState = {
  phase: "idle" | "preparing" | "ready" | "error";
  steps: PrepStep[];
  sprints: SprintProgress[];
  chatId: string | null;
  error: string | null;
  progress: number;
};

const INITIAL_STEPS: PrepStep[] = [
  { id: "validate", label: "Validating sprint access", status: "pending" },
  { id: "create-chat", label: "Creating session", status: "pending" },
  { id: "build-context", label: "Retrieving sprint research", status: "pending" },
  { id: "save-context", label: "Saving context", status: "pending" },
];

function calcProgress(
  steps: PrepStep[],
  sprints: SprintProgress[],
): number {
  // Weight: validate(10) + create-chat(10) + sprints(65) + save-context(5) + ready(10)
  let progress = 0;

  for (const step of steps) {
    if (step.id === "validate" && (step.status === "done" || step.status === "error"))
      progress += 10;
    if (step.id === "create-chat" && (step.status === "done" || step.status === "error"))
      progress += 10;
    if (step.id === "save-context" && (step.status === "done" || step.status === "error"))
      progress += 5;
  }

  // Sprint progress — analyzing=30%, recalling=70%, done=100% of their share
  if (sprints.length > 0) {
    let sprintProgress = 0;
    for (const s of sprints) {
      if (s.status === "analyzing") sprintProgress += 0.3;
      else if (s.status === "recalling") sprintProgress += 0.7;
      else if (s.status === "done") sprintProgress += 1;
    }
    progress += Math.round((sprintProgress / sprints.length) * 65);
  }

  return Math.min(progress, 100);
}

interface StartParams {
  chatId: string;
  sprintIds: string[];
  sprintTitles: Map<string, string>;
  visibility?: "public" | "private";
}

export function useSprintPreparation() {
  const [state, setState] = useState<PreparationState>({
    phase: "idle",
    steps: [],
    sprints: [],
    chatId: null,
    error: null,
    progress: 0,
  });

  const abortRef = useRef<AbortController | null>(null);
  const lastParamsRef = useRef<StartParams | null>(null);

  const start = useCallback(async (params: StartParams) => {
    lastParamsRef.current = params;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    const initialSprints: SprintProgress[] = params.sprintIds.map((id) => ({
      sprintId: id,
      title: params.sprintTitles.get(id) ?? "Sprint",
      status: "pending" as const,
    }));

    setState({
      phase: "preparing",
      steps: INITIAL_STEPS.map((s) => ({ ...s })),
      sprints: initialSprints,
      chatId: params.chatId,
      error: null,
      progress: 0,
    });

    try {
      const response = await fetch("/api/sprint/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: params.chatId,
          sprintIds: params.sprintIds,
          visibility: params.visibility ?? "private",
        }),
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
            next.sprints = [...prev.sprints];

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
            } else if (eventType === "sprint") {
              const sprintIdx = next.sprints.findIndex(
                (s) => s.sprintId === data.sprintId,
              );
              if (sprintIdx !== -1) {
                const sprint = { ...next.sprints[sprintIdx] };
                sprint.title = data.title ?? sprint.title;
                sprint.status = data.status as SprintProgress["status"];
                sprint.message = data.message;
                if (data.charCount !== undefined) sprint.charCount = data.charCount;
                if (data.resultCount !== undefined) sprint.resultCount = data.resultCount;
                next.sprints[sprintIdx] = sprint;
              }
            } else if (eventType === "ready") {
              next.phase = "ready";
              next.chatId = data.chatId;
              next.progress = 100;
              return next;
            } else if (eventType === "error") {
              next.phase = "error";
              next.error = data.message ?? "Preparation failed";
              return next;
            }

            next.progress = calcProgress(next.steps, next.sprints);
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
  }, []);

  const retry = useCallback(() => {
    if (lastParamsRef.current) {
      start(lastParamsRef.current);
    }
  }, [start]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    lastParamsRef.current = null;
    setState({
      phase: "idle",
      steps: [],
      sprints: [],
      chatId: null,
      error: null,
      progress: 0,
    });
  }, []);

  return { state, start, retry, reset };
}
