"use client";

import type { UIMessage } from "ai";
import { useEffect, useRef } from "react";
import { ChatMessage } from "./message";

type MessageListProps = {
  messages: UIMessage[];
  isLoading?: boolean;
};

export function MessageList({ messages, isLoading }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMessageCountRef = useRef(messages.length);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Find the scroll container on mount
    if (bottomRef.current && !scrollContainerRef.current) {
      scrollContainerRef.current = bottomRef.current.closest('.layout-scroll');
    }
  }, []);

  useEffect(() => {
    // Only scroll when a new message is added, not on content updates
    const messageCountChanged = messages.length !== prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    if (messageCountChanged && bottomRef.current) {
      // Check if user is near bottom before auto-scrolling
      const container = scrollContainerRef.current;
      if (container) {
        const threshold = 100; // px from bottom
        const isNearBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight < threshold;

        if (isNearBottom || messages.length === 1) {
          // Use instant scroll to prevent glitching during streaming
          bottomRef.current.scrollIntoView({ behavior: "instant", block: "end" });
        }
      } else {
        // Fallback if container not found
        bottomRef.current.scrollIntoView({ behavior: "instant", block: "end" });
      }
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-end p-8 justify-center h-full">
        {/* <p className="text-[10rem] leading-[8rem] text-blue-300">Tell your <br /> <div className="w-full translate-x-[10.86rem]">story</div> </p> */}
        {/* <p className="text-[10rem] leading-[8rem] text-blue-400 font-bold">welcome</p> */}
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl flex-1 mx-auto">
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} />
      ))}
      {isLoading && (
        <div className="flex justify-start">
          <div className="rounded-2xl bg-muted px-4 py-2">
            <span className="animate-pulse">Thinking...</span>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
