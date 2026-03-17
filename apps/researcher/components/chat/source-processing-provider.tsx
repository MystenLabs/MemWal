"use client";

import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

// --- Types ---

export type SourceEvent =
  | { type: "processing"; label: string }
  | {
      type: "processed";
      label: string;
      title: string;
      chunkCount: number;
      sourceId: string;
    }
  | { type: "error"; label: string; error: string }
  | { type: "done"; count: number };

type SourceProcessingContextValue = {
  events: SourceEvent[];
  pushEvent: (event: SourceEvent) => void;
  clear: () => void;
};

const SourceProcessingContext =
  createContext<SourceProcessingContextValue | null>(null);

// --- Provider ---

export function SourceProcessingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [events, setEvents] = useState<SourceEvent[]>([]);

  const pushEvent = useCallback((event: SourceEvent) => {
    setEvents((prev) => [...prev, event]);
  }, []);

  const clear = useCallback(() => {
    setEvents([]);
  }, []);

  const value = useMemo(
    () => ({ events, pushEvent, clear }),
    [events, pushEvent, clear]
  );

  return (
    <SourceProcessingContext.Provider value={value}>
      {children}
    </SourceProcessingContext.Provider>
  );
}

export function useSourceProcessing() {
  const context = useContext(SourceProcessingContext);
  if (!context) {
    throw new Error(
      "useSourceProcessing must be used within SourceProcessingProvider"
    );
  }
  return context;
}
