"use client";

/**
 * Enhanced Memory Panel Component
 *
 * Right-side panel with inline approval UI and progress tracking.
 * Shows detected memories and allows approve/reject without modal.
 *
 * Features:
 * - Inline approval buttons
 * - Animated progress stages
 * - Status filtering (all/pending/saved)
 * - Statistics summary
 * - Visual polish with animations
 */

import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import { Separator } from "@/shared/components/ui/separator";
import type { MemoryData } from "@/shared/db/type";
import { cn } from "@/shared/lib/utils";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, type SerializedEditorState } from "lexical";
import {
  Check,
  CheckCircle2,
  Clock,
  Database,
  ExternalLink,
  Loader2,
  RotateCcw,
  Upload,
  X,
  XCircle
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useNoteMemorySave } from "../hook/use-note-memory-save";
import { ZKLOGIN_CONFIG } from "@/feature/auth/constant";
import { $getAllMemories, REMOVE_MEMORY_HIGHLIGHT_COMMAND, UPDATE_MEMORY_STATUS_COMMAND } from "../plugins/MemoryHighlightPlugin";

const STATUS_CONFIGS = {
  preparing: {
    label: "Preparing",
    icon: Loader2,
    color: "text-gray-600 dark:text-gray-400",
    bgColor: "bg-gray-50 dark:bg-gray-900/20",
    borderColor: "border-gray-200 dark:border-gray-800",
    animate: "animate-pulse",
  },
  pending: {
    label: "Pending",
    icon: Clock,
    color: "text-yellow-600 dark:text-yellow-400",
    bgColor: "bg-yellow-50 dark:bg-yellow-900/20",
    borderColor: "border-yellow-200 dark:border-yellow-800",
  },
  signing: {
    label: "Signing",
    icon: Loader2,
    color: "text-purple-600 dark:text-purple-400",
    bgColor: "bg-purple-50 dark:bg-purple-900/20",
    borderColor: "border-purple-200 dark:border-purple-800",
    animate: "animate-spin",
  },
  uploading: {
    label: "Uploading",
    icon: Upload,
    color: "text-indigo-600 dark:text-indigo-400",
    bgColor: "bg-indigo-50 dark:bg-indigo-900/20",
    borderColor: "border-indigo-200 dark:border-indigo-800",
    animate: "animate-pulse",
  },
  indexing: {
    label: "Indexing",
    icon: Database,
    color: "text-cyan-600 dark:text-cyan-400",
    bgColor: "bg-cyan-50 dark:bg-cyan-900/20",
    borderColor: "border-cyan-200 dark:border-cyan-800",
    animate: "animate-pulse",
  },
  saved: {
    label: "Saved",
    icon: CheckCircle2,
    color: "text-green-600 dark:text-green-400",
    bgColor: "bg-green-50 dark:bg-green-900/20",
    borderColor: "border-green-200 dark:border-green-800",
  },
  error: {
    label: "Error",
    icon: XCircle,
    color: "text-red-600 dark:text-red-400",
    bgColor: "bg-red-50 dark:bg-red-900/20",
    borderColor: "border-red-200 dark:border-red-800",
  },
  rejected: {
    label: "Rejected",
    icon: X,
    color: "text-gray-600 dark:text-gray-400",
    bgColor: "bg-gray-50 dark:bg-gray-900/20",
    borderColor: "border-gray-200 dark:border-gray-800",
  },
};

export interface MemoryPanelEnhancedProps {
  onHighlightClick?: (memoryId: string) => void;
  onRegisterClickHandler?: (handler: (memoryId: string) => void) => void;
  onSaveComplete?: (content: SerializedEditorState, plainText: string) => Promise<void>;
}

export function MemoryPanelEnhanced({
  onHighlightClick,
  onRegisterClickHandler,
  onSaveComplete,
}: MemoryPanelEnhancedProps) {
  const [editor] = useLexicalComposerContext();
  const [memories, setMemories] = useState<MemoryData[]>([]);
  const [expandedMemoryId, setExpandedMemoryId] = useState<string | null>(null);
  const { saveMemory, isSaving, currentMemoryId } = useNoteMemorySave();
  const memoryRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Extract memories from editor state
  useEffect(() => {
    const updateMemories = () => {
      editor.getEditorState().read(() => {
        const memoryNodes = $getAllMemories();        const memoryData = memoryNodes.map((node) => node.getMemoryData());        setMemories(memoryData);
      });
    };    updateMemories();

    const unregister = editor.registerUpdateListener(() => {
      updateMemories();
    });

    return () => unregister();
  }, [editor]);

  // Handle approve
  const handleApprove = useCallback(
    async (memoryId: string) => {
      try {
        setExpandedMemoryId(memoryId);
        await saveMemory(memoryId);
        toast.success("Memory saved to blockchain!");

        // Force immediate save to persist the final "saved" status
        if (onSaveComplete) {
          editor.getEditorState().read(() => {
            const root = $getRoot();
            const plainText = root.getTextContent();
            const content = editor.getEditorState().toJSON();
            onSaveComplete(content, plainText).catch((err) => {
              console.error("Failed to persist memory status:", err);
            });
          });
        }
      } catch (error) {
        console.error("Failed to save memory:", error);
        toast.error(
          error instanceof Error ? error.message : "Failed to save memory"
        );
      }
    },
    [saveMemory, editor, onSaveComplete]
  );

  // Handle reject
  const handleReject = useCallback(
    (memoryId: string) => {
      editor.dispatchCommand(REMOVE_MEMORY_HIGHLIGHT_COMMAND, { memoryId });
      toast.info("Memory rejected");
      setExpandedMemoryId(null);
    },
    [editor]
  );

  // Handle retry - reset status back to pending
  const handleRetry = useCallback(
    (memoryId: string) => {
      editor.dispatchCommand(UPDATE_MEMORY_STATUS_COMMAND, {
        memoryId,
        status: "pending",
        meta: {
          errorMessage: undefined,
        },
      });
      setExpandedMemoryId(memoryId);
      toast.info("Memory reset to pending");

      // Immediately save to persist the reset status
      if (onSaveComplete) {
        // Wait a tick for the command to be processed
        setTimeout(() => {
          editor.getEditorState().read(() => {
            const root = $getRoot();
            const plainText = root.getTextContent();
            const content = editor.getEditorState().toJSON();
            onSaveComplete(content, plainText).catch((err) => {
              console.error("Failed to persist retry status:", err);
            });
          });
        }, 100);
      }
    },
    [editor, onSaveComplete]
  );

  // Handle external click from highlight - scroll to memory and expand it
  const handleMemoryClick = useCallback((memoryId: string) => {
    setExpandedMemoryId(memoryId);

    // Scroll to the memory card
    setTimeout(() => {
      const element = memoryRefs.current.get(memoryId);
      if (element) {
        element.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });

        // Flash effect to draw attention
        element.classList.add("ring-2", "ring-blue-500", "ring-offset-2");
        setTimeout(() => {
          element.classList.remove("ring-2", "ring-blue-500", "ring-offset-2");
        }, 1000);
      }
    }, 100);

    // Call parent callback if provided
    onHighlightClick?.(memoryId);
  }, [onHighlightClick]);

  // Register the click handler with parent component
  useEffect(() => {
    onRegisterClickHandler?.(handleMemoryClick);
  }, [handleMemoryClick, onRegisterClickHandler]);

  // Empty state
  if (memories.length === 0) {
    return (
      <aside className="w-80 border-l flex flex-col h-full">
        <div className="p-4 border-b">
          <h3 className="font-semibold">Memories</h3>
          <p className="text-xs text-muted-foreground mt-1">
            No memories yet
          </p>
        </div>
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center text-muted-foreground">
            {/* <Sparkles className="h-8 w-8 mx-auto mb-3 opacity-50" /> */}
            <p className="text-sm font-medium">No memories detected</p>
            <p className="text-xs mt-2">
              Click "Detect Memories" to find memorable moments
            </p>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-80 border-l flex flex-col h-full overflow-hidden">
      {/* Simple header */}
      <p className="text-xs text-muted-foreground mt-1 px-3 h-7.25 flex items-center border-b">
        {/* {memories.length} {memories.length === 1 ? "memory" : "memories"} */}
      </p>

      {/* Memory list - scrollable */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-3">
          {memories.map((memory) => (
            <MemoryCard
              key={memory.id}
              ref={(el) => {
                if (el) {
                  memoryRefs.current.set(memory.id, el);
                } else {
                  memoryRefs.current.delete(memory.id);
                }
              }}
              memory={memory}
              isExpanded={expandedMemoryId === memory.id}
              isProcessing={currentMemoryId === memory.id && isSaving}
              onApprove={() => handleApprove(memory.id)}
              onReject={() => handleReject(memory.id)}
              onRetry={() => handleRetry(memory.id)}
              onToggleExpand={() =>
                setExpandedMemoryId(
                  expandedMemoryId === memory.id ? null : memory.id
                )
              }
              onClick={() => handleMemoryClick(memory.id)}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

// Individual memory card component
interface MemoryCardProps {
  memory: MemoryData;
  isExpanded: boolean;
  isProcessing: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRetry: () => void;
  onToggleExpand: () => void;
  onClick: () => void;
}

const MemoryCard = forwardRef<HTMLDivElement, MemoryCardProps>(
  function MemoryCard(
    {
      memory,
      isExpanded,
      isProcessing,
      onApprove,
      onReject,
      onRetry,
      onToggleExpand,
      onClick,
    },
    ref
  ) {
    const config = STATUS_CONFIGS[memory.status] || STATUS_CONFIGS.pending;
    const Icon = config.icon;

    const isProcessingStage =
      memory.status === "signing" ||
      memory.status === "uploading" ||
      memory.status === "indexing";

    return (
      <div
        ref={ref}
        className={cn(
          "rounded-lg border transition-all duration-200 p-2.5",
          config.borderColor,
          config.bgColor,
          isExpanded ? "ring-2 ring-offset-2 ring-offset-background" : "",
          "hover:shadow-md cursor-pointer"
        )}
        onClick={(e) => {
          // Don't trigger card click if clicking buttons
          if ((e.target as HTMLElement).closest("button")) return;
          onClick();
          onToggleExpand();
        }}
      >
        <div className="space-y-2">
          {/* Compact metadata row */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Badge variant="outline" className="text-xs shrink-0">
                {memory.category}
              </Badge>
              <span className="text-xs opacity-70 shrink-0">
                {memory.importance}/10
              </span>
            </div>

            {/* Status badge */}
            <div className="flex items-center gap-1.5 shrink-0">
              <Icon
                className={cn(
                  "h-3.5 w-3.5",
                  config.color,
                  "animate" in config ? config.animate : ""
                )}
              />
              <span className={cn("text-xs font-medium", config.color)}>
                {config.label}
              </span>
            </div>
          </div>

          {/* Text preview (2 lines max) */}
          {!isExpanded && (
            <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
              {memory.text}
            </p>
          )}

          {/* Expanded content */}
          {isExpanded && (
            <>
              <Separator className="my-2" />

              {/* Progress stages (for processing states) */}
              {isProcessingStage && (
                <div className="space-y-2 py-2">
                  <ProgressStage
                    label="Sign transaction"
                    status={
                      memory.status === "signing"
                        ? "active"
                        : ["uploading", "indexing", "saved"].includes(
                          memory.status
                        )
                          ? "completed"
                          : "pending"
                    }
                  />
                  <ProgressStage
                    label="Upload to Walrus"
                    status={
                      memory.status === "uploading"
                        ? "active"
                        : ["indexing", "saved"].includes(memory.status)
                          ? "completed"
                          : "pending"
                    }
                  />
                  <ProgressStage
                    label="Index memory"
                    status={
                      memory.status === "indexing"
                        ? "active"
                        : memory.status === "saved"
                          ? "completed"
                          : "pending"
                    }
                  />
                </div>
              )}

              {/* Saved blockchain data */}
              {memory.status === "saved" && memory.memwalMemoryId && (
                <div className="space-y-1.5 py-2">
                  <div className="text-xs font-medium text-green-700 dark:text-green-300">
                    Blockchain Data
                  </div>
                  <div className="space-y-1 text-xs text-muted-foreground font-mono">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">Memory: {memory.memwalMemoryId.slice(0, 12)}...</span>
                      {memory.memwalBlobId && (
                        <a
                          href={`https://walruscan.com/${ZKLOGIN_CONFIG.network}/blob/${memory.memwalBlobId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 p-0.5 text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    {memory.memwalBlobId && (
                      <div className="truncate">Blob: {memory.memwalBlobId.slice(0, 12)}...</div>
                    )}
                  </div>
                </div>
              )}

              {/* Error message */}
              {memory.status === "error" && memory.errorMessage && (
                <div className="p-2 rounded bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-800">
                  <p className="text-xs text-red-700 dark:text-red-300">
                    {memory.errorMessage}
                  </p>
                </div>
              )}

              {/* Action buttons */}
              {memory.status === "pending" && (
                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReject();
                    }}
                    disabled={isProcessing}
                    className="flex-1"
                  >
                    <X className="h-3.5 w-3.5 mr-1.5" />
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onApprove();
                    }}
                    disabled={isProcessing}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                  >
                    <Check className="h-3.5 w-3.5 mr-1.5" />
                    Approve
                  </Button>
                </div>
              )}

              {/* Retry/Cancel buttons for error or stuck processing states */}
              {(memory.status === "error" ||
                (isProcessingStage && !isProcessing)) && (
                  <div className="flex gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onReject();
                      }}
                      className="flex-1"
                    >
                      <X className="h-3.5 w-3.5 mr-1.5" />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRetry();
                      }}
                      className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                    >
                      <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                      Retry
                    </Button>
                  </div>
                )}
            </>
          )}
        </div>
      </div>
    );
  });

// Progress stage component
interface ProgressStageProps {
  label: string;
  status: "pending" | "active" | "completed";
}

function ProgressStage({ label, status }: ProgressStageProps) {
  return (
    <div className="flex items-center gap-2">
      {status === "active" && (
        <Loader2 className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 animate-spin" />
      )}
      {status === "completed" && (
        <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
      )}
      {status === "pending" && (
        <div className="h-3.5 w-3.5 rounded-full border-2 border-gray-300 dark:border-gray-600" />
      )}
      <span
        className={cn(
          "text-xs",
          status === "active"
            ? "font-medium text-blue-700 dark:text-blue-300"
            : status === "completed"
              ? "text-green-700 dark:text-green-300"
              : "text-muted-foreground"
        )}
      >
        {label}
      </span>
    </div>
  );
}
