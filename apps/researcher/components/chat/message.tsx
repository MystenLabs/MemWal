"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import { useState } from "react";
import type { ChatMessage } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { useDataStream } from "../data/data-stream-provider";
import { MessageContent } from "../elements/message";
import { Response } from "../elements/response";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "../elements/tool";
import { SourceCard, type SourceCardData } from "../sources/source-card";
import { SparklesIcon } from "../icons";
import { MessageActions } from "./message-actions";
import { MessageEditor } from "./message-editor";
import { MessageReasoning } from "./message-reasoning";
import { PreviewAttachment } from "./preview-attachment";

const PurePreviewMessage = ({
  addToolApprovalResponse,
  chatId,
  message,
  isLoading,
  setMessages,
  regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  message: ChatMessage;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
}) => {
  const [mode, setMode] = useState<"view" | "edit">("view");

  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );

  useDataStream();

  return (
    <div
      className="group/message fade-in w-full animate-in duration-200"
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn("flex w-full items-start gap-2 md:gap-3", {
          "justify-end": message.role === "user" && mode !== "edit",
          "justify-start": message.role === "assistant",
        })}
      >
        {message.role === "assistant" && (
          <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
            <SparklesIcon size={14} />
          </div>
        )}

        <div
          className={cn("flex flex-col", {
            "gap-2 md:gap-4": message.parts?.some(
              (p) => p.type === "text" && p.text?.trim()
            ),
            "w-full":
              (message.role === "assistant" &&
                (message.parts?.some(
                  (p) => p.type === "text" && p.text?.trim()
                ) ||
                  message.parts?.some((p) => p.type.startsWith("tool-")))) ||
              mode === "edit",
            "max-w-[calc(100%-2.5rem)] sm:max-w-[min(fit-content,80%)]":
              message.role === "user" && mode !== "edit",
          })}
        >
          {attachmentsFromMessage.length > 0 && (
            <div
              className="flex flex-row justify-end gap-2"
              data-testid={"message-attachments"}
            >
              {attachmentsFromMessage.map((attachment) => (
                <PreviewAttachment
                  attachment={{
                    name: attachment.filename ?? "file",
                    contentType: attachment.mediaType,
                    url: attachment.url,
                  }}
                  key={attachment.url}
                />
              ))}
            </div>
          )}

          {message.parts?.map((part, index) => {
            const { type } = part;
            const key = `message-${message.id}-part-${index}`;

            if (type === "reasoning") {
              const hasContent = part.text?.trim().length > 0;
              if (hasContent) {
                const isStreaming =
                  "state" in part && part.state === "streaming";
                return (
                  <MessageReasoning
                    isLoading={isLoading || isStreaming}
                    key={key}
                    reasoning={part.text}
                  />
                );
              }
            }

            if (type === "text") {
              if (mode === "view") {
                return (
                  <div key={key}>
                    <MessageContent
                      className={cn({
                        "wrap-break-word w-fit rounded-2xl px-3 py-2 text-right text-white":
                          message.role === "user",
                        "bg-transparent px-0 py-0 text-left":
                          message.role === "assistant",
                      })}
                      data-testid="message-content"
                      style={
                        message.role === "user"
                          ? { backgroundColor: "#006cff" }
                          : undefined
                      }
                    >
                      <Response>{sanitizeText(part.text)}</Response>
                    </MessageContent>
                  </div>
                );
              }

              if (mode === "edit") {
                return (
                  <div
                    className="flex w-full flex-row items-start gap-3"
                    key={key}
                  >
                    <div className="size-8" />
                    <div className="min-w-0 flex-1">
                      <MessageEditor
                        key={message.id}
                        message={message}
                        regenerate={regenerate}
                        setMessages={setMessages}
                        setMode={setMode}
                      />
                    </div>
                  </div>
                );
              }
            }

            if (type === "tool-listSources") {
              const { toolCallId, state } = part;

              if (state === "output-available") {
                const output = (part as any).output as {
                  sources: Array<{
                    id: string;
                    type: "url" | "pdf";
                    title: string | null;
                    url: string | null;
                    summary: string | null;
                    claims: string[] | null;
                    chunkCount: number | null;
                    createdAt: string;
                  }>;
                  total?: number;
                  message?: string;
                };

                if (!output.sources || output.sources.length === 0) {
                  return (
                    <div key={toolCallId} className="w-full">
                      <Tool className="w-full" defaultOpen={false}>
                        <ToolHeader state={state} type="tool-listSources" />
                        <ToolContent>
                          <div className="px-4 py-3 text-sm text-muted-foreground">
                            {output.message || "No sources found."}
                          </div>
                        </ToolContent>
                      </Tool>
                    </div>
                  );
                }

                return (
                  <div key={toolCallId} className="w-full">
                    <Tool className="w-full" defaultOpen={false}>
                      <ToolHeader state={state} type="tool-listSources" />
                      <ToolContent>
                        <div className="space-y-2 p-3">
                          {output.sources.map((s) => (
                            <SourceCard
                              key={s.id}
                              source={{
                                ...s,
                                createdAt: new Date(s.createdAt).toISOString(),
                                expiresAt: new Date(
                                  new Date(s.createdAt).getTime() +
                                    7 * 24 * 60 * 60 * 1000,
                                ).toISOString(),
                              }}
                              variant="compact"
                            />
                          ))}
                        </div>
                      </ToolContent>
                    </Tool>
                  </div>
                );
              }

              return (
                <div key={toolCallId} className="w-full">
                  <Tool className="w-full" defaultOpen={false}>
                    <ToolHeader state={state} type="tool-listSources" />
                    <ToolContent>
                      <div className="px-4 py-3 text-sm text-muted-foreground">
                        Looking up sources...
                      </div>
                    </ToolContent>
                  </Tool>
                </div>
              );
            }

            if (type === "tool-searchSourceContent") {
              const { toolCallId, state } = part;

              if (state === "output-available") {
                const output = (part as any).output as {
                  results: Array<{
                    section: string;
                    content: string;
                    sourceId: string;
                  }>;
                  total?: number;
                  message?: string;
                };

                if (!output.results || output.results.length === 0) {
                  return (
                    <div key={toolCallId} className="w-full">
                      <Tool className="w-full" defaultOpen={false}>
                        <ToolHeader
                          state={state}
                          type="tool-searchSourceContent"
                        />
                        <ToolContent>
                          <div className="px-4 py-3 text-sm text-muted-foreground">
                            {output.message || "No matching content found."}
                          </div>
                        </ToolContent>
                      </Tool>
                    </div>
                  );
                }

                return (
                  <div key={toolCallId} className="w-full">
                    <Tool className="w-full" defaultOpen={false}>
                      <ToolHeader
                        state={state}
                        type="tool-searchSourceContent"
                      />
                      <ToolContent>
                        <div className="divide-y">
                          {output.results.map((result, i) => (
                            <div key={`${result.sourceId}-${i}`} className="px-4 py-3">
                              <p className="mb-1 text-xs font-medium text-primary">
                                {result.section}
                              </p>
                              <p className="line-clamp-4 text-sm text-foreground/90">
                                {result.content}
                              </p>
                            </div>
                          ))}
                        </div>
                      </ToolContent>
                    </Tool>
                  </div>
                );
              }

              return (
                <div key={toolCallId} className="w-full">
                  <Tool className="w-full" defaultOpen={false}>
                    <ToolHeader
                      state={state}
                      type="tool-searchSourceContent"
                    />
                    <ToolContent>
                      <div className="px-4 py-3 text-sm text-muted-foreground">
                        Searching sources...
                      </div>
                    </ToolContent>
                  </Tool>
                </div>
              );
            }

            return null;
          })}

          {!isReadonly && (
            <MessageActions
              chatId={chatId}
              isLoading={isLoading}
              key={`action-${message.id}`}
              message={message}
              setMode={setMode}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export const PreviewMessage = PurePreviewMessage;

export const ThinkingMessage = () => {
  return (
    <div
      className="group/message fade-in w-full animate-in duration-300"
      data-role="assistant"
      data-testid="message-assistant-loading"
    >
      <div className="flex items-start justify-start gap-3">
        <div className="-mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border">
          <div className="animate-pulse">
            <SparklesIcon size={14} />
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 md:gap-4">
          <div className="flex items-center gap-1 p-0 text-muted-foreground text-sm">
            <span className="animate-pulse">Thinking</span>
            <span className="inline-flex">
              <span className="animate-bounce [animation-delay:0ms]">.</span>
              <span className="animate-bounce [animation-delay:150ms]">.</span>
              <span className="animate-bounce [animation-delay:300ms]">.</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
