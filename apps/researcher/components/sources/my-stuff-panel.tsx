"use client";

import { BookOpenIcon, XIcon, InboxIcon, BookmarkIcon } from "lucide-react";
import { memo, useState } from "react";
import { useSources } from "@/hooks/use-sources";
import { useSprints, type SprintListItem } from "@/hooks/use-sprints";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SourceCard, type SourceCardData } from "./source-card";
import { SprintCard } from "./sprint-card";
import { SprintDetail } from "./sprint-detail";

function PureMyStuffPanel({
  isOpen,
  onClose,
  onUseSourceInChat,
}: {
  isOpen: boolean;
  onClose: () => void;
  onUseSourceInChat?: (source: SourceCardData) => void;
}) {
  const { sources, isLoading: sourcesLoading } = useSources();
  const { sprints, isLoading: sprintsLoading } = useSprints();
  const [selectedSprint, setSelectedSprint] = useState<SprintListItem | null>(
    null
  );

  // Split sources into active and expired
  const now = new Date();
  const activeSources: SourceCardData[] = [];
  const expiredSources: SourceCardData[] = [];

  for (const s of sources) {
    const cardData: SourceCardData = {
      id: s.id,
      type: s.type as "url" | "pdf",
      title: s.title,
      url: s.url,
      summary: s.summary,
      claims: s.claims,
      chunkCount: s.chunkCount,
      createdAt: new Date(s.createdAt).toISOString(),
      expiresAt: new Date(
        new Date(s.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000
      ).toISOString(),
    };

    const expiresAt = new Date(cardData.expiresAt!);
    if (expiresAt < now) {
      expiredSources.push(cardData);
    } else {
      activeSources.push(cardData);
    }
  }

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        className={cn(
          "fixed right-0 top-0 z-50 flex h-dvh w-full flex-col border-l bg-background transition-transform duration-300 ease-in-out md:w-[420px]",
          isOpen ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* Sprint detail view — overlays the panel content */}
        {selectedSprint ? (
          <SprintDetail
            sprint={selectedSprint}
            onBack={() => setSelectedSprint(null)}
          />
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <BookOpenIcon className="size-4" />
                <h2 className="text-sm font-semibold">My Stuff</h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <XIcon className="size-4" />
              </button>
            </div>

            {/* Tabbed content */}
            <Tabs defaultValue="sources" className="flex min-h-0 flex-1 flex-col">
              <div className="px-4 pt-3">
                <TabsList className="w-full">
                  <TabsTrigger value="sources" className="flex-1">
                    Sources
                    {sources.length > 0 && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        ({sources.length})
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="sprints" className="flex-1">
                    Sprints
                    {sprints.length > 0 && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        ({sprints.length})
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>

              {/* Sources tab */}
              <TabsContent
                value="sources"
                className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"
              >
                {sourcesLoading ? (
                  <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="h-16 animate-pulse rounded-lg bg-muted"
                      />
                    ))}
                  </div>
                ) : sources.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
                    <InboxIcon className="size-8 text-muted-foreground/50" />
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        No sources yet
                      </p>
                      <p className="text-xs text-muted-foreground/70">
                        Paste a URL or attach a PDF in the chat
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeSources.length > 0 && (
                      <div className="space-y-2">
                        {activeSources.map((s) => (
                          <SourceCard
                            key={s.id}
                            source={s}
                            variant="compact"
                            onUseInChat={onUseSourceInChat}
                          />
                        ))}
                      </div>
                    )}

                    {expiredSources.length > 0 && (
                      <>
                        <p className="mt-4 text-xs font-medium text-muted-foreground">
                          Expired ({expiredSources.length})
                        </p>
                        <div className="space-y-2">
                          {expiredSources.map((s) => (
                            <SourceCard
                              key={s.id}
                              source={s}
                              variant="compact"
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </TabsContent>

              {/* Sprints tab */}
              <TabsContent
                value="sprints"
                className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"
              >
                {sprintsLoading ? (
                  <div className="space-y-2">
                    {[1, 2].map((i) => (
                      <div
                        key={i}
                        className="h-20 animate-pulse rounded-lg bg-muted"
                      />
                    ))}
                  </div>
                ) : sprints.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
                    <BookmarkIcon className="size-8 text-muted-foreground/50" />
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        No sprints yet
                      </p>
                      <p className="text-xs text-muted-foreground/70">
                        Click &quot;Save Sprint&quot; in a chat to save your
                        research findings
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {sprints.map((sprint) => (
                      <SprintCard
                        key={sprint.id}
                        sprint={sprint}
                        onClick={() => setSelectedSprint(sprint)}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </>
  );
}

export const MyStuffPanel = memo(PureMyStuffPanel);
