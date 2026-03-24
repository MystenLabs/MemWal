"use client";

import useSWR from "swr";
import type { Source } from "@/lib/db/schema";
import { fetcher } from "@/lib/utils";

export function useSources() {
  const { data, error, isLoading, mutate } = useSWR<Source[]>(
    "/api/research/sources",
    fetcher,
  );

  return {
    sources: data ?? [],
    isLoading,
    error,
    mutate,
  };
}
