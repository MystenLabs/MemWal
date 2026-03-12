"use client";

import { motion, AnimatePresence } from "framer-motion";
import {
  BrainIcon,
  CheckCircleIcon,
  LoaderIcon,
  MinusIcon,
  SearchIcon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { PreparationState, SprintProgress } from "@/hooks/use-sprint-preparation";

export function SprintPreparationScreen({
  state,
  onRetry,
  onBack,
}: {
  state: PreparationState;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <motion.div
      key="preparing"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex h-dvh flex-col items-center justify-center bg-background px-4"
    >
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex flex-col items-center gap-3"
        >
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
            <BrainIcon className="size-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">
            {state.phase === "ready"
              ? "Session Ready"
              : state.phase === "error"
                ? "Preparation Failed"
                : "Preparing Your Session"}
          </h2>
        </motion.div>

        {/* Step list */}
        <div className="space-y-3">
          {state.steps.map((step, i) => (
            <motion.div
              key={step.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.15 + i * 0.06 }}
              className="flex items-start gap-3"
            >
              <StepIcon status={step.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {step.status === "active" ? (
                    <Shimmer className="text-sm font-medium">
                      {step.label}
                    </Shimmer>
                  ) : (
                    <span
                      className={`text-sm font-medium ${
                        step.status === "done"
                          ? "text-foreground"
                          : step.status === "error"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      }`}
                    >
                      {step.label}
                    </span>
                  )}
                </div>
                {step.status === "error" && step.message && (
                  <p className="mt-0.5 text-xs text-destructive">
                    {step.message}
                  </p>
                )}

                {/* Sprint sub-items under build-context */}
                {step.id === "build-context" &&
                  (step.status === "active" || step.status === "done") &&
                  state.sprints.length > 0 && (
                    <div className="mt-2 space-y-2 pl-1">
                      {state.sprints.map((sprint, si) => (
                        <SprintItem key={sprint.sprintId} sprint={sprint} index={si} />
                      ))}
                    </div>
                  )}
              </div>
            </motion.div>
          ))}
        </div>

        {/* Progress bar */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
        >
          <Progress value={state.progress} className="h-2" />
        </motion.div>

        {/* Ready message */}
        <AnimatePresence>
          {state.phase === "ready" && (
            <motion.p
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center text-sm text-muted-foreground"
            >
              Context ready — redirecting...
            </motion.p>
          )}
        </AnimatePresence>

        {/* Error actions */}
        {state.phase === "error" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex justify-center gap-3"
          >
            <Button variant="outline" size="sm" onClick={onBack}>
              Go Back
            </Button>
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}

function SprintItem({ sprint, index }: { sprint: SprintProgress; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.08 }}
      className="space-y-0.5"
    >
      <div className="flex items-center gap-2">
        <SprintIcon status={sprint.status} />
        <span
          className={`text-xs font-medium ${
            sprint.status === "done" ? "text-foreground" : "text-muted-foreground"
          }`}
        >
          {sprint.title}
        </span>
      </div>
      {/* Sub-status message */}
      {sprint.status === "analyzing" && (
        <div className="flex items-center gap-1.5 pl-5">
          <SparklesIcon className="size-2.5 text-amber-500" />
          <span className="text-[11px] text-muted-foreground">Analyzing metadata...</span>
        </div>
      )}
      {sprint.status === "recalling" && (
        <div className="flex items-center gap-1.5 pl-5">
          <SearchIcon className="size-2.5 text-blue-500" />
          <span className="text-[11px] text-muted-foreground">{sprint.message ?? "Searching memory..."}</span>
        </div>
      )}
      {sprint.status === "done" && sprint.resultCount !== undefined && (
        <div className="pl-5">
          <span className="text-[11px] text-muted-foreground">
            {sprint.resultCount} findings retrieved
            {sprint.charCount ? ` (${(sprint.charCount / 1000).toFixed(1)}k chars)` : ""}
          </span>
        </div>
      )}
    </motion.div>
  );
}

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "done":
      return (
        <motion.div
          initial={{ scale: 0.8 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
        >
          <CheckCircleIcon className="mt-0.5 size-4 text-green-500" />
        </motion.div>
      );
    case "active":
      return <LoaderIcon className="mt-0.5 size-4 animate-spin text-primary" />;
    case "error":
      return <XCircleIcon className="mt-0.5 size-4 text-destructive" />;
    default:
      return <MinusIcon className="mt-0.5 size-4 text-muted-foreground/40" />;
  }
}

function SprintIcon({ status }: { status: string }) {
  switch (status) {
    case "done":
      return (
        <motion.div initial={{ scale: 0.8 }} animate={{ scale: 1 }}>
          <CheckCircleIcon className="size-3 text-green-500" />
        </motion.div>
      );
    case "analyzing":
      return <SparklesIcon className="size-3 animate-pulse text-amber-500" />;
    case "recalling":
      return <LoaderIcon className="size-3 animate-spin text-blue-500" />;
    default:
      return <MinusIcon className="size-3 text-muted-foreground/40" />;
  }
}
