"use client";

/**
 * Memory Hover Preview Component
 *
 * Shows a rich preview card when hovering over memory highlights in the editor.
 * Displays memory metadata, status, and blockchain information.
 */

import { Badge } from "@/shared/components/ui/badge";
import { Card, CardContent } from "@/shared/components/ui/card";
import { Separator } from "@/shared/components/ui/separator";
import type { MemoryData } from "@/shared/db/type";
import { cn } from "@/shared/lib/utils";
import { ZKLOGIN_CONFIG } from "@/feature/auth/constant";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Database,
  ExternalLink,
  Loader2,
  Upload,
  XCircle
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

const STATUS_ICONS = {
  preparing: Loader2,
  pending: Clock,
  signing: Loader2,
  uploading: Upload,
  indexing: Database,
  saved: CheckCircle2,
  error: XCircle,
  rejected: AlertCircle,
} as const;

const STATUS_LABELS = {
  preparing: "Preparing Memory",
  pending: "Awaiting Approval",
  signing: "Signing Transaction",
  uploading: "Uploading to Walrus",
  indexing: "Indexing Memory",
  saved: "Saved to Blockchain",
  error: "Failed to Save",
  rejected: "Rejected",
} as const;

const CATEGORY_EMOJIS = {
  note: "📝",
  fact: "💡",
  preference: "⭐",
  todo: "✅",
  general: "💭",
} as const;

interface MemoryHoverPreviewProps {
  memory: MemoryData | null;
  position: { x: number; y: number } | null;
  onClose: () => void;
}

export function MemoryHoverPreview({
  memory,
  position,
  onClose,
}: MemoryHoverPreviewProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

  // Adjust position to keep card in viewport
  useEffect(() => {
    if (!position || !cardRef.current) {
      setAdjustedPosition(position);
      return;
    }

    const card = cardRef.current;
    const cardRect = card.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let { x, y } = position;

    // Adjust horizontal position
    if (x + cardRect.width > viewportWidth - 20) {
      x = viewportWidth - cardRect.width - 20;
    }
    if (x < 20) {
      x = 20;
    }

    // Adjust vertical position
    if (y + cardRect.height > viewportHeight - 20) {
      y = y - cardRect.height - 40; // Position above if no space below
    }

    setAdjustedPosition({ x, y });
  }, [position, memory]);

  if (!memory || !adjustedPosition) {
    return null;
  }

  const StatusIcon = STATUS_ICONS[memory.status];
  const statusLabel = STATUS_LABELS[memory.status];
  const categoryEmoji = CATEGORY_EMOJIS[memory.category];

  const isProcessing =
    memory.status === "signing" ||
    memory.status === "uploading" ||
    memory.status === "indexing";

  return (
    <>
      {/* Preview Card - No backdrop to prevent flickering */}
      <Card
        ref={cardRef}
        className={cn(
          "p-0 fixed z-50 w-80 shadow-none border animate-in fade-in-0 zoom-in-95",
          "transition-all duration-200 ease-out",
          memory.status === "saved"
            ? "border-green-300 dark:border-green-700"
            : memory.status === "error"
              ? "border-red-300 dark:border-red-700"
              : "border-border"
        )}
        style={{
          left: `${adjustedPosition.x}px`,
          top: `${adjustedPosition.y}px`,
          pointerEvents: "auto",
        }}
        onMouseEnter={(e) => {
          e.stopPropagation();
          // Keep the preview visible when mouse enters it
        }}
        onMouseLeave={(e) => {
          e.stopPropagation();
          // Close when mouse leaves the preview
          onClose();
        }}
      >
        <CardContent className="p-2 space-y-2">
          {/* Header with status */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {/* <span className="text-lg">{categoryEmoji}</span> */}
              <div className="min-w-0 flex-1">
                <Badge variant="outline" className="mb-1">
                  {memory.category}
                </Badge>
                <div className="flex items-center gap-1.5 text-sm">
                  <StatusIcon
                    className={cn(
                      "h-3.5 w-3.5",
                      isProcessing && "animate-spin",
                      memory.status === "saved" &&
                      "text-green-600 dark:text-green-400",
                      memory.status === "error" &&
                      "text-red-600 dark:text-red-400",
                      memory.status === "pending" &&
                      "text-yellow-600 dark:text-yellow-400"
                    )}
                  />
                  <span className="text-muted-foreground text-xs">
                    {statusLabel}
                  </span>
                </div>
              </div>
            </div>

            {/* Importance indicator */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <span className="text-xs font-medium">
                {memory.importance}/10
              </span>
            </div>
          </div>

          <Separator />

          {/* Embedding info */}
          {memory.embedding && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database className="h-3 w-3" />
              <span>Vector: {memory.embedding.length} dimensions</span>
            </div>
          )}

          {/* Blockchain data (saved memories) */}
          {memory.status === "saved" && memory.memwalMemoryId && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                  <span className="text-xs font-medium text-green-700 dark:text-green-300">
                    Saved to Blockchain
                  </span>
                </div>

                <div className="space-y-1.5 pl-5">
                  {/* Memory ID */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground font-mono truncate">
                      {memory.memwalMemoryId.slice(0, 16)}...
                    </span>
                    {memory.memwalBlobId && (
                      <a
                        href={`https://walruscan.com/${ZKLOGIN_CONFIG.network}/blob/${memory.memwalBlobId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>

                  {/* Blob ID */}
                  {memory.memwalBlobId && (
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      Blob: {memory.memwalBlobId.slice(0, 16)}...
                    </div>
                  )}

                  {/* Saved timestamp */}
                  {memory.savedAt && (
                    <div className="text-xs text-muted-foreground">
                      {new Date(memory.savedAt).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Error message */}
          {memory.status === "error" && memory.errorMessage && (
            <>
              <Separator />
              <div className="flex items-start gap-2 p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                <AlertCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed">
                  {memory.errorMessage}
                </p>
              </div>
            </>
          )}

          {/* Created timestamp */}
          <div className="text-xs text-muted-foreground pt-1 border-t">
            Created {new Date(memory.createdAt).toLocaleString()}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
