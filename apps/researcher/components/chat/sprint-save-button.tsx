"use client";

import { BookmarkIcon, CheckIcon, LoaderIcon } from "lucide-react";
import { useState } from "react";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSprintStatus } from "@/hooks/use-sprint-status";
import { toast } from "@/components/toast";

export function SprintSaveButton({
  chatId,
  hasMessages,
}: {
  chatId: string;
  hasMessages: boolean;
}) {
  const { mutate: globalMutate } = useSWRConfig();
  const { hasSprint, sprintTitle, isLoading, mutate } =
    useSprintStatus(chatId);
  const [isSaving, setIsSaving] = useState(false);

  if (!hasMessages) return null;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const response = await fetch("/api/sprint/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to save sprint");
      }

      const result = await response.json();
      toast({
        type: "success",
        description: `Sprint saved: "${result.title}"`,
      });
      mutate();
      globalMutate("/api/sprint/list");
    } catch (error) {
      toast({
        type: "error",
        description:
          error instanceof Error ? error.message : "Failed to save sprint",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const disabled = hasSprint || isSaving || isLoading;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          className="order-4 h-8 gap-1.5 px-2 md:h-fit md:px-2"
          disabled={disabled}
          onClick={handleSave}
          variant="outline"
        >
          {isSaving ? (
            <LoaderIcon className="size-4 animate-spin" />
          ) : hasSprint ? (
            <CheckIcon className="size-4" />
          ) : (
            <BookmarkIcon className="size-4" />
          )}
          <span className="hidden sm:inline">
            {isSaving
              ? "Saving..."
              : hasSprint
                ? "Saved"
                : "Save Sprint"}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {hasSprint
          ? `Sprint saved: "${sprintTitle}"`
          : "Save research findings to MemWal"}
      </TooltipContent>
    </Tooltip>
  );
}
