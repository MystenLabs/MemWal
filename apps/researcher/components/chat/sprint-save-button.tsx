"use client";

import { BookmarkIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSprintStatus } from "@/hooks/use-sprint-status";

export function SprintSaveButton({
  chatId,
  hasMessages,
  onSave,
}: {
  chatId: string;
  hasMessages: boolean;
  onSave: () => void;
}) {
  const { hasSprint, sprintTitle, isLoading } =
    useSprintStatus(chatId);

  if (!hasMessages) return null;

  const disabled = hasSprint || isLoading;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          className="order-4 h-8 gap-1.5 px-2 md:h-fit md:px-2"
          disabled={disabled}
          onClick={onSave}
          variant={hasSprint ? "outline" : "default"}
        >
          {hasSprint ? (
            <CheckIcon className="size-4" />
          ) : (
            <BookmarkIcon className="size-4" />
          )}
          <span className="hidden sm:inline">
            {hasSprint ? "Saved" : "Save Sprint"}
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
