"use client";

import { BookOpenIcon, XIcon, InboxIcon } from "lucide-react";
import { memo } from "react";
import { useSources } from "@/hooks/use-sources";
import { cn } from "@/lib/utils";
import { SourceCard, type SourceCardData } from "./source-card";

function PureMyStuffPanel({
  isOpen,
  onClose,
  onUseSourceInChat,
}: {
  isOpen: boolean;
  onClose: () => void;
  onUseSourceInChat?: (source: SourceCardData) => void;
}) {
  const { sources, isLoading } = useSources();

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
      // Estimate expiry: createdAt + 7 days (since we don't store expiresAt on source)
      expiresAt: new Date(
        new Date(s.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000,
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
          "fixed right-0 top-0 z-50 flex h-dvh w-full flex-col border-l bg-background transition-transform duration-300 ease-in-out md:w-[380px]",
          isOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
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

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {/* Research Sprints — Phase 2 placeholder */}
          <section className="mb-6">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Research Sprints
            </h3>
            <div className="rounded-lg border border-dashed p-4 text-center">
              <p className="text-sm text-muted-foreground">
                Coming soon — save research checkpoints to Walrus
              </p>
            </div>
          </section>

          {/* Sources */}
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sources
            </h3>

            {isLoading ? (
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
                    Add a URL or PDF using the source button
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
          </section>
        </div>
      </div>
    </>
  );
}

export const MyStuffPanel = memo(PureMyStuffPanel);
