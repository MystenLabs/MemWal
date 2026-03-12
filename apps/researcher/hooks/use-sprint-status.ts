"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/utils";

interface SprintStatus {
  hasSprint: boolean;
  sprintId: string | null;
  title: string | null;
}

export function useSprintStatus(chatId: string) {
  const { data, error, isLoading, mutate } = useSWR<SprintStatus>(
    `/api/sprint/status?chatId=${chatId}`,
    fetcher,
  );

  return {
    hasSprint: data?.hasSprint ?? false,
    sprintId: data?.sprintId ?? null,
    sprintTitle: data?.title ?? null,
    isLoading,
    error,
    mutate,
  };
}
