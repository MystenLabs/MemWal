import type { UseChatHelpers } from "@ai-sdk/react";
import { ArrowDownIcon } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { useMessages } from "@/hooks/use-messages";
import type { ChatMessage } from "@/lib/types";
import { useDataStream } from "../data/data-stream-provider";
import { Greeting } from "./greeting";
import { PreviewMessage, ThinkingMessage } from "./message";
import { SourceProcessingStatus, useSourceProcessing } from "./source-processing-status";

type MessagesProps = {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  status: UseChatHelpers<ChatMessage>["status"];
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  selectedModelId: string;
};

// Memoize to avoid re-renders on every streaming token
const MemoizedSourceProcessingStatus = memo(SourceProcessingStatus);

function PureMessages({
  addToolApprovalResponse,
  chatId,
  status,
  messages,
  setMessages,
  regenerate,
  isReadonly,
  selectedModelId: _selectedModelId,
}: MessagesProps) {
  const {
    containerRef: messagesContainerRef,
    endRef: messagesEndRef,
    isAtBottom,
    scrollToBottom,
    hasSentMessage,
  } = useMessages({
    status,
  });

  useDataStream();

  // Clear source processing events when a new request starts
  const { clear: clearSourceEvents, events: sourceEvents } = useSourceProcessing();
  const prevStatus = useRef(status);
  useEffect(() => {
    if (status === "submitted" && prevStatus.current === "ready") {
      clearSourceEvents();
    }
    prevStatus.current = status;
  }, [status, clearSourceEvents]);

  // Find where to insert the source processing status:
  // After the last user message, before the assistant response
  const hasSourceEvents = sourceEvents.length > 0;
  const isActive = status === "submitted" || status === "streaming";
  const showSourceStatus = hasSourceEvents && isActive;

  // Find the index of the last user message in the current turn
  let sourceStatusInsertIndex = -1;
  if (showSourceStatus) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        sourceStatusInsertIndex = i + 1; // insert after this user message
        break;
      }
    }
  }

  return (
    <div className="relative flex-1 bg-background">
      <div
        className="absolute inset-0 touch-pan-y overflow-y-auto bg-background"
        ref={messagesContainerRef}
      >
        <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-4 px-2 py-4 md:gap-6 md:px-4">
          {messages.length === 0 && <Greeting />}

          {messages.flatMap((message, index) => {
            const items = [
              <PreviewMessage
                addToolApprovalResponse={addToolApprovalResponse}
                chatId={chatId}
                isLoading={
                  status === "streaming" && messages.length - 1 === index
                }
                isReadonly={isReadonly}
                key={message.id}
                message={message}
                regenerate={regenerate}
                requiresScrollPadding={
                  hasSentMessage && index === messages.length - 1
                }
                setMessages={setMessages}
              />,
            ];

            // Render source status right after the last user message
            if (index + 1 === sourceStatusInsertIndex) {
              items.push(
                <MemoizedSourceProcessingStatus key="source-processing-status" />
              );
            }

            return items;
          })}

          {status === "submitted" &&
            !messages.some((msg) =>
              msg.parts?.some(
                (part) => "state" in part && part.state === "approval-responded"
              )
            ) && <ThinkingMessage />}

          <div
            className="min-h-[24px] min-w-[24px] shrink-0"
            ref={messagesEndRef}
          />
        </div>
      </div>

      <button
        aria-label="Scroll to bottom"
        className={`absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border bg-background p-2 shadow-lg transition-all hover:bg-muted ${
          isAtBottom
            ? "pointer-events-none scale-0 opacity-0"
            : "pointer-events-auto scale-100 opacity-100"
        }`}
        onClick={() => scrollToBottom("smooth")}
        type="button"
      >
        <ArrowDownIcon className="size-4" />
      </button>
    </div>
  );
}

export const Messages = PureMessages;
