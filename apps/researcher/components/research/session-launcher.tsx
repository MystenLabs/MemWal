"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeftIcon, ArrowRightIcon, BrainIcon, SearchIcon, XIcon } from "lucide-react";
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
          {/* Top bar */}
          <header className="flex items-center justify-between border-b px-6 py-4">
            <div className="flex items-center gap-3">
              <Link
                href="/"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeftIcon className="size-4" />
              </Link>
              <BrainIcon className="size-5 text-primary" />
              <h1 className="text-lg font-semibold">New Research Session</h1>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleJustChat}>
                Just Chat
                <ArrowRightIcon className="ml-1 size-3.5" />
              </Button>
            </div>
          </header>

          {/* Main content */}
          <div className="flex min-h-0 flex-1">
            {/* Left column — sprint selection */}
            <div className="flex w-full flex-col border-r md:w-[400px] lg:w-[440px]">
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

              {/* Action buttons */}
              <div className="flex gap-2 border-t px-4 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStartFresh}
                  disabled={selectedIds.size === 0}
                  className="flex-1"
                >
                  Start Fresh
                </Button>
                <Button
                  size="sm"
                  onClick={handleStartChat}
                  disabled={selectedIds.size === 0}
                  className="flex-1"
                >
                  Start Chat
                  <ArrowRightIcon className="ml-1 size-3.5" />
                </Button>
              </div>
            </div>

            {/* Right column — preview */}
            <div className="hidden flex-1 md:block">
              {previewSprint ? (
                <SprintDetail
                  sprint={previewSprint}
                  onBack={() => setPreviewId(null)}
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-muted-foreground">
                    Click a sprint to preview its details
                  </p>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
