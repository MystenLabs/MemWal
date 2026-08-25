"use client";

import { useEffect, useRef, useState } from "react";

type SprintGreetingData = {
  greeting: string;
  suggestions: string[];
  isLoading: boolean;
};

/**
 * Fallback prompts shown when the chat has no sprints to generate from.
 *
 * Exported because SuggestedActions previously kept its own byte-identical
 * copy, and only this one was ever reachable — editing the other silently did
 * nothing. Kept to a similar, short length so each pill sits on one line.
 */
export const DEFAULT_SUGGESTIONS = [
  "What sources do I have?",
  "Research advances in decentralized storage",
  "Compare SEAL with traditional encryption",
  "Summarize my blockchain scalability research",
];

export function useSprintGreeting(sprintIds?: string[]): SprintGreetingData {
  const hasSprints = !!sprintIds?.length;
  const [greeting, setGreeting] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>(
    hasSprints ? [] : DEFAULT_SUGGESTIONS
  );
  const [isLoading, setIsLoading] = useState(hasSprints);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!sprintIds?.length || fetchedRef.current) return;

    const controller = new AbortController();

    async function fetchData() {
      try {
        const res = await fetch("/api/sprint/suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sprintIds }),
          signal: controller.signal,
        });

        if (!res.ok) throw new Error("Failed to fetch");

        const data = await res.json();
        fetchedRef.current = true;
        setGreeting(data.greeting || "");
        setSuggestions(
          data.suggestions?.length ? data.suggestions : DEFAULT_SUGGESTIONS
        );
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setSuggestions(DEFAULT_SUGGESTIONS);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }

    fetchData();
    return () => {
      controller.abort();
    };
  }, [sprintIds]);

  return { greeting, suggestions, isLoading };
}
