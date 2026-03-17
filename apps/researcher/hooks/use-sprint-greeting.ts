"use client";

import { useEffect, useRef, useState } from "react";

type SprintGreetingData = {
  greeting: string;
  suggestions: string[];
  isLoading: boolean;
};

const DEFAULT_SUGGESTIONS = [
  "What sources do I have?",
  "Help me research the latest advances in decentralized storage",
  "Compare SEAL encryption with traditional approaches",
  "Summarize my research on blockchain scalability",
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
