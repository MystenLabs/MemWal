"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { motion } from "framer-motion";
import { memo } from "react";
// DEFAULT_SUGGESTIONS is imported rather than redeclared: this file used to
// keep a byte-identical copy that was never reachable, because
// useSprintGreeting always supplies the fallback via sprintSuggestions.
import { DEFAULT_SUGGESTIONS } from "@/hooks/use-sprint-greeting";
import type { ChatMessage } from "@/lib/types";
import { Suggestion } from "../elements/suggestion";
import type { VisibilityType } from "./visibility-selector";

type SuggestedActionsProps = {
  chatId: string;
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  selectedVisibilityType: VisibilityType;
  sprintSuggestions?: string[];
  sprintSuggestionsLoading?: boolean;
};

function PureSuggestedActions({
  chatId,
  sendMessage,
  sprintSuggestions,
  sprintSuggestionsLoading,
}: SuggestedActionsProps) {
  const suggestions =
    sprintSuggestions?.length ? sprintSuggestions : DEFAULT_SUGGESTIONS;
  const isLoading = !!sprintSuggestionsLoading;

  if (isLoading) {
    return (
      <div
        className="grid w-full gap-2 sm:grid-cols-2"
        data-testid="suggested-actions"
      >
        {[0, 1, 2, 3].map((i) => (
          <motion.div
            animate={{ opacity: 1 }}
            initial={{ opacity: 0 }}
            key={i}
            transition={{ delay: 0.05 * i }}
          >
            <div className="h-[42px] w-full animate-pulse rounded-full border border-border bg-muted/40" />
          </motion.div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="grid w-full gap-2 sm:grid-cols-2"
      data-testid="suggested-actions"
    >
      {suggestions.map((suggestedAction, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          initial={{ opacity: 0, y: 20 }}
          key={suggestedAction}
          transition={{ delay: 0.05 * index }}
        >
          <Suggestion
            className="h-[42px] w-full whitespace-nowrap p-3"
            onClick={(suggestion) => {
              window.history.pushState({}, "", `/chat/${chatId}`);
              sendMessage({
                role: "user",
                parts: [{ type: "text", text: suggestion }],
              });
            }}
            suggestion={suggestedAction}
            title={suggestedAction}
          >
            {/* min-w-0 lets truncate work inside the button's flex layout, so an
                over-long sprint suggestion ellipsises instead of wrapping and
                making one pill taller than the rest. Full text is in `title`. */}
            <span className="min-w-0 truncate">{suggestedAction}</span>
          </Suggestion>
        </motion.div>
      ))}
    </div>
  );
}

export const SuggestedActions = memo(
  PureSuggestedActions,
  (prevProps, nextProps) => {
    if (prevProps.chatId !== nextProps.chatId) {
      return false;
    }
    if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
      return false;
    }
    if (prevProps.sprintSuggestionsLoading !== nextProps.sprintSuggestionsLoading) {
      return false;
    }

    return true;
  }
);
