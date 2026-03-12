"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/utils";

export interface SprintListItem {
  id: string;
  blobId: string;
  title: string;
  summary: string | null;
  reportContent: string | null;
  citations: Array<{
    refIndex: number;
    sourceId: string;
    sourceTitle: string;
    sourceUrl: string | null;
    section: string;
    supportingChunks: string[];
    scope: string;
  }> | null;
  sources: Array<{
    sourceId: string;
    title: string | null;
    url: string | null;
    type: "url" | "pdf";
  }> | null;
  tags: string[] | null;
  chatId: string | null;
  memoryCount: number | null;
  createdAt: string;
}

export function useSprints() {
  const { data, error, isLoading, mutate } = useSWR<SprintListItem[]>(
    "/api/sprint/list",
    fetcher
  );

  return {
    sprints: data ?? [],
    isLoading,
    error,
    mutate,
  };
}
