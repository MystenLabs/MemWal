"use client";

import { ChatRenderer } from "@/feature/editor";
import { extractTextFromParts, extractToolParts } from "../domain/ai";
import type { ChatMessageWithTimestamp } from "../domain/type";
import { ToolUI } from "./ai-tool-ui";

type ChatMessageProps = {
  message: ChatMessageWithTimestamp;
};

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  // User message - simple bubble
  if (isUser) {
    const text = extractTextFromParts(message.parts);
    return (
      <div className="flex w-full justify-end mb-1">
        <div className="max-w-[80%] rounded-2xl px-3 py-1.5 bg-primary text-primary-foreground">
          <ChatRenderer text={text} className="text-sm" />
        </div>
      </div>
    );
  }

  // AI message with tool support
  const text = extractTextFromParts(message.parts);
  const tools = extractToolParts(message.parts);

  // Don't render if no text and no completed tools
  const hasCompletedTools = tools.some((t) => t.state === "output-available");
  if (!text && !hasCompletedTools) {
    return null;
  }

  return (
    <div className="flex gap-3 group">
      {/* Content */}
      <div className="flex-1 space-y-2">
        {/* Model badge */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground group-hover:opacity-100 opacity-0 transition-opacity">
          <span>
            {message.createdAt
              ? new Date(message.createdAt).toLocaleTimeString()
              : new Date().toLocaleTimeString()}
          </span>
        </div>

        {/* Text content */}
        {text && (
          <ChatRenderer text={text} className="text-sm text-foreground/90" />
        )}

        {/* Tool invocations */}
        {tools.length > 0 && (
          <div className="space-x-1">
            {tools.map((tool) => (
              <ToolUI key={tool.toolCallId} tool={tool} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
