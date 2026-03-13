"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BrainIcon,
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

            {/* Right column — preview or empty state */}
            <div className="hidden flex-1 md:flex md:flex-col">
              {previewSprint ? (
                <SprintDetail
                  sprint={previewSprint}
                  onBack={() => setPreviewId(null)}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8">
                  {/* Just Chat CTA */}
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex size-16 items-center justify-center rounded-2xl border bg-card shadow-sm">
                      <MessageSquareIcon className="size-7 text-muted-foreground" strokeWidth={1.5} />
                    </div>
                    <div className="flex flex-col items-center gap-1.5 text-center">
                      <h2 className="text-base font-semibold">Start a fresh chat</h2>
                      <p className="max-w-[280px] text-sm text-muted-foreground">
                        Jump straight into a new conversation without any sprint context
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={handleJustChat}
                      className="gap-2"
                    >
                      <MessageSquareIcon className="size-4" />
                      Just Chat
                      <ArrowRightIcon className="size-4" />
                    </Button>
                  </div>

                  {/* Divider */}
                  <div className="flex w-full max-w-[240px] items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground">or</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  {/* Hint */}
                  <p className="max-w-[280px] text-center text-sm text-muted-foreground">
                    Select sprints from the left to bring previous research into your new session
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Mobile-only Just Chat button — fixed at bottom for small screens */}
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
