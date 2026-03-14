"use client";

import { motion, AnimatePresence } from "framer-motion";
import {
  BookmarkIcon,
  CheckCircleIcon,
  LoaderIcon,
  MinusIcon,
  XCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { SprintSaveState } from "@/hooks/use-sprint-save";

export function SprintSaveOverlay({
  state,
  onRetry,
  onClose,
}: {
  state: SprintSaveState;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {state.phase !== "idle" && (
        <motion.div
          key="sprint-save-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.25, delay: 0.05 }}
            className="w-full max-w-md rounded-xl border bg-background p-6 shadow-lg"
          >
            <div className="space-y-6">
              {/* Header */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="flex flex-col items-center gap-3"
              >
                <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                  {state.phase === "done" ? (
                    <motion.div
                      initial={{ scale: 0.5 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 300, damping: 20 }}
                    >
                      <CheckCircleIcon className="size-6 text-green-500" />
                    </motion.div>
                  ) : state.phase === "error" ? (
                    <XCircleIcon className="size-6 text-destructive" />
                  ) : (
                    <BookmarkIcon className="size-6 text-primary" />
                  )}
                </div>
                <h2 className="text-lg font-semibold">
                  {state.phase === "done"
                    ? "Sprint Saved"
                    : state.phase === "error"
                      ? "Save Failed"
                      : "Saving Sprint"}
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

              {/* Done state */}
              <AnimatePresence>
                {state.phase === "done" && state.result && (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="space-y-4"
                  >
                    <p className="text-center text-sm text-muted-foreground">
                      &ldquo;{state.result.title}&rdquo;
                    </p>
                    <div className="flex justify-center">
                      <Button size="sm" onClick={onClose}>
                        Done
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Error state */}
              {state.phase === "error" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="space-y-3"
                >
                  {state.error && (
                    <p className="text-center text-sm text-destructive">
                      {state.error}
                    </p>
                  )}
                  <div className="flex justify-center gap-3">
                    <Button variant="outline" size="sm" onClick={onClose}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={onRetry}>
                      Retry
                    </Button>
                  </div>
                </motion.div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
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
