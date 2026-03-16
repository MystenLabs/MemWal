"use client";

import { Button } from "@/shared/components/ui/button";
import { SendHorizontal } from "lucide-react";
import { ChatEditor } from "@/feature/editor";
import { ModelSelector } from "./model-selector";

type ChatInputProps = {
  input: string;
  setInput: (value: string) => void;
  onSubmit: () => void;
  isLoading?: boolean;
};

export function ChatInput({
  input,
  setInput,
  onSubmit,
  isLoading,
}: ChatInputProps) {
  return (
    <div className="pb-3.5 sticky bottom-0">
      {/* Input wrapper */}
      <div className="relative w-full max-w-2xl mx-auto min-h-20 bg-secondary rounded-lg">
        <ChatEditor
          value={input}
          onChange={setInput}
          onSubmit={() => {
            if (input.trim() && !isLoading) {
              onSubmit();
            }
          }}
          disabled={isLoading}
          placeholder="Ask anything... ($ for coins, Enter to send)"
          className="flex-1"
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          <ModelSelector />
          <Button
            onClick={onSubmit}
            disabled={!input.trim() || isLoading}
            size="icon-sm"
          >
            <SendHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
