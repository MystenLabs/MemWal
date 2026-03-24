"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BrainIcon,
  ClockIcon,
  DatabaseIcon,
  FileTextIcon,
  MessageSquareIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SprintDetail } from "@/components/sources/sprint-detail";
import { SprintPreparationScreen } from "./sprint-preparation-screen";
import { SprintSelectCard } from "./sprint-select-card";
import { useSprintPreparation } from "@/hooks/use-sprint-preparation";
import type { SprintListItem } from "@/hooks/use-sprints";
import { generateUUID } from "@/lib/utils";

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) return "just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SessionLauncher({
  sprints,
}: {
  sprints: SprintListItem[];
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"select" | "preparing">("select");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const preparation = useSprintPreparation();

  const filteredSprints = useMemo(() => {
    if (!searchQuery.trim()) return sprints;
    const q = searchQuery.toLowerCase();
    return sprints.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.summary?.toLowerCase().includes(q) ?? false) ||
        (s.tags?.some((t) => t.toLowerCase().includes(q)) ?? false)
    );
  }, [sprints, searchQuery]);

  const previewSprint = useMemo(
    () => sprints.find((s) => s.id === previewId) ?? null,
    [sprints, previewId]
  );

  // Stats
  const totalSources = useMemo(
    () => sprints.reduce((sum, s) => sum + (s.sources?.length ?? 0), 0),
    [sprints]
  );
  const totalMemories = useMemo(
    () => sprints.reduce((sum, s) => sum + (s.memoryCount ?? 0), 0),
    [sprints]
  );

  // Recent sprints (last 3, sorted by date)
  const recentSprints = useMemo(
    () =>
      [...sprints]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 3),
    [sprints]
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleStartChat = () => {
    const chatId = generateUUID();
    const sprintTitles = new Map(sprints.map((s) => [s.id, s.title]));

    preparation.start({
      chatId,
      sprintIds: Array.from(selectedIds),
      sprintTitles,
    });
    setPhase("preparing");
  };

  const handleStartFresh = () => {
    setSelectedIds(new Set());
    setPreviewId(null);
  };

  const handleJustChat = () => {
    router.push("/");
  };

  const handleBackFromPreparation = () => {
    preparation.reset();
    setPhase("select");
  };

  // Redirect on ready — only when actively in preparing phase
  useEffect(() => {
    if (phase === "preparing" && preparation.state.phase === "ready" && preparation.state.chatId) {
      const timer = setTimeout(() => {
        router.push(`/chat/${preparation.state.chatId}`);
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [phase, preparation.state.phase, preparation.state.chatId, router]);

  return (
    <AnimatePresence mode="wait">
      {phase === "preparing" ? (
        <SprintPreparationScreen
          key="preparing"
          state={preparation.state}
          onRetry={preparation.retry}
          onBack={handleBackFromPreparation}
        />
      ) : (
        <motion.div
          key="select"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex h-dvh flex-col bg-background"
        >
          {/* Header */}
          <header className="flex items-center gap-3 border-b px-6 py-4">
            <Link
              href="/"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4" />
            </Link>
            <BrainIcon className="size-5 text-primary" />
            <h1 className="text-lg font-semibold">New Research Session</h1>
          </header>

          {/* Main content */}
          <div className="flex min-h-0 flex-1">
            {/* Left column — sprint selection */}
            <div className="flex w-full flex-col border-r md:w-[420px] lg:w-[460px]">
              {/* Search */}
              <div className="border-b px-4 py-3">
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="Search sprints..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Select sprints to bring their context into your new session.
                  {selectedIds.size > 0 && (
                    <span className="ml-1 font-medium text-primary">
                      {selectedIds.size} selected
                    </span>
                  )}
                </p>
              </div>

              {/* Sprint list */}
              <div className="flex-1 space-y-2 overflow-y-auto p-4">
                {filteredSprints.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {searchQuery ? "No sprints match your search." : "No sprints available."}
                  </p>
                ) : (
                  filteredSprints.map((sprint) => (
                    <SprintSelectCard
                      key={sprint.id}
                      sprint={sprint}
                      isSelected={selectedIds.has(sprint.id)}
                      isPreviewing={previewId === sprint.id}
                      onToggleSelect={() => toggleSelect(sprint.id)}
                      onPreview={() =>
                        setPreviewId((prev) =>
                          prev === sprint.id ? null : sprint.id
                        )
                      }
                    />
                  ))
                )}
              </div>

              {/* Bottom actions */}
              <div className="flex items-center gap-2 border-t px-4 py-3">
                {selectedIds.size > 0 ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleStartFresh}
                      className="text-muted-foreground"
                    >
                      Clear
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleStartChat}
                      className="flex-1"
                    >
                      <SparklesIcon className="mr-1.5 size-3.5" />
                      Start with {selectedIds.size} sprint{selectedIds.size !== 1 ? "s" : ""}
                      <ArrowRightIcon className="ml-1.5 size-3.5" />
                    </Button>
                  </>
                ) : (
                  <p className="flex-1 text-center text-xs text-muted-foreground">
                    Select sprints above or start a fresh chat
                  </p>
                )}
              </div>
            </div>

            {/* Right column — preview or knowledge hub */}
            <div className="hidden min-h-0 flex-1 md:flex md:flex-col">
              {previewSprint ? (
                <SprintDetail
                  sprint={previewSprint}
                  onBack={() => setPreviewId(null)}
                />
              ) : (
                <div className="flex flex-1 flex-col overflow-y-auto">
                  {/* Knowledge stats banner */}
                  <div className="border-b px-8 py-6">
                    <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                      Your Research Memory
                    </h2>
                    <div className="mt-4 grid grid-cols-3 gap-4">
                      <div className="rounded-lg border bg-card p-3">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <BrainIcon className="size-4" />
                          <span className="text-xs font-medium">Sprints</span>
                        </div>
                        <p className="mt-1 text-2xl font-bold">{sprints.length}</p>
                      </div>
                      <div className="rounded-lg border bg-card p-3">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <FileTextIcon className="size-4" />
                          <span className="text-xs font-medium">Sources</span>
                        </div>
                        <p className="mt-1 text-2xl font-bold">{totalSources}</p>
                      </div>
                      <div className="rounded-lg border bg-card p-3">
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <DatabaseIcon className="size-4" />
                          <span className="text-xs font-medium">Memories</span>
                        </div>
                        <p className="mt-1 text-2xl font-bold">{totalMemories}</p>
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Your findings are persisted on-chain via MemWal and recalled across sessions.
                    </p>
                  </div>

                  {/* Recent research */}
                  <div className="border-b px-8 py-6">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                      <ClockIcon className="size-3.5" />
                      Recent Research
                    </h2>
                    <div className="mt-4 space-y-3">
                      {recentSprints.map((sprint) => (
                        <button
                          key={sprint.id}
                          type="button"
                          onClick={() => {
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(sprint.id)) {
                                next.delete(sprint.id);
                              } else {
                                next.add(sprint.id);
                              }
                              return next;
                            });
                          }}
                          className="group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-all hover:border-primary/30 hover:bg-primary/5"
                        >
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                            <BrainIcon className="size-4 text-muted-foreground" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-sm font-medium">
                              {sprint.title}
                            </h3>
                            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{formatRelativeDate(sprint.createdAt)}</span>
                              {(sprint.sources?.length ?? 0) > 0 && (
                                <span>{sprint.sources?.length} sources</span>
                              )}
                            </div>
                          </div>
                          <div className="mt-0.5 shrink-0">
                            {selectedIds.has(sprint.id) ? (
                              <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
                                Selected
                              </span>
                            ) : (
                              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                                + Add
                              </span>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Just Chat CTA */}
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-6">
                    <div className="flex flex-col items-center gap-2 text-center">
                      <div className="flex size-12 items-center justify-center rounded-xl border bg-card shadow-sm">
                        <MessageSquareIcon className="size-5 text-muted-foreground" strokeWidth={1.5} />
                      </div>
                      <p className="text-sm font-medium">Want to start fresh?</p>
                      <p className="max-w-[260px] text-xs text-muted-foreground">
                        Start a new conversation without any sprint context
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleJustChat}
                      className="gap-2"
                    >
                      <MessageSquareIcon className="size-3.5" />
                      Just Chat
                      <ArrowRightIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Mobile-only Just Chat button */}
          <div className="border-t px-4 py-3 md:hidden">
            <Button
              variant="outline"
              onClick={handleJustChat}
              className="w-full gap-2"
            >
              <MessageSquareIcon className="size-4" />
              Just Chat
              <ArrowRightIcon className="size-4" />
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
