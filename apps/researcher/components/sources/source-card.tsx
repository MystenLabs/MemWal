"use client";

import { FileTextIcon, LinkIcon, ClockIcon } from "lucide-react";
import { memo } from "react";
import { cn } from "@/lib/utils";

export type SourceCardData = {
  id: string;
  type: "url" | "pdf";
  title: string | null;
  url?: string | null;
  summary?: string | null;
  claims?: string[] | null;
  chunkCount?: number | null;
  createdAt: string;
  expiresAt?: string | null;
};

function isExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) < new Date();
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function PureSourceCard({
  source,
  variant = "full",
  onUseInChat,
}: {
  source: SourceCardData;
  variant?: "full" | "compact";
  onUseInChat?: (source: SourceCardData) => void;
}) {
  const expired = isExpired(source.expiresAt);
  const Icon = source.type === "pdf" ? FileTextIcon : LinkIcon;

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "group flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50",
          expired && "opacity-60",
        )}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {source.title || "Untitled"}
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{source.chunkCount ?? 0} chunks</span>
            <span>·</span>
            {expired ? (
              <span className="text-amber-500">Expired</span>
            ) : source.expiresAt ? (
              <span>Expires {formatDate(source.expiresAt)}</span>
            ) : (
              <span>{formatDate(source.createdAt)}</span>
            )}
          </div>
        </div>
        {onUseInChat && !expired && (
          <button
            type="button"
            onClick={() => onUseInChat(source)}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-primary opacity-0 transition-opacity hover:bg-primary/10 group-hover:opacity-100"
          >
            Use
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-4",
        expired && "opacity-70",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-tight">
            {source.title || "Untitled"}
          </p>
          {source.url && (
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 block truncate text-xs text-muted-foreground hover:text-primary"
            >
              {source.url}
            </a>
          )}
        </div>
      </div>

      {source.summary && (
        <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
          {source.summary}
        </p>
      )}

      {source.claims && source.claims.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {source.claims.slice(0, 4).map((claim) => (
            <span
              key={claim}
              className="inline-block max-w-[200px] truncate rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
            >
              {claim}
            </span>
          ))}
          {source.claims.length > 4 && (
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
              +{source.claims.length - 4} more
            </span>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
        <span>{source.chunkCount ?? 0} chunks</span>
        <span>·</span>
        <span>{formatDate(source.createdAt)}</span>
        {expired ? (
          <>
            <span>·</span>
            <span className="flex items-center gap-1 text-amber-500">
              <ClockIcon className="size-3" />
              Chunks expired
            </span>
          </>
        ) : source.expiresAt ? (
          <>
            <span>·</span>
            <span className="flex items-center gap-1">
              <ClockIcon className="size-3" />
              Expires {formatDate(source.expiresAt)}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export const SourceCard = memo(PureSourceCard);
