import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
} from "ai";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { getSession } from "@/lib/auth/session";
import { allowedModelIds } from "@/lib/ai/models";
import { researchPrompt, getSprintResumePrompt } from "@/lib/ai/prompts";
import { buildSprintContext } from "@/lib/sprint/resume";
import {
  extractUrlsFromText,
  type SourceInput,
} from "@/lib/ai/source-processing";
import { getLanguageModel } from "@/lib/ai/providers";
import { getResearchTools, processSource } from "@/lib/rag";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 120;

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch (_) {
    return null;
  }
}

export { getStreamContext };

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    const session = await getSession();

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    if (!allowedModelIds.has(selectedChatModel)) {
      return new ChatbotError("bad_request:api").toResponse();
    }

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 1,
    });

    if (messageCount > 100) {
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      if (!isToolApprovalFlow) {
        messagesFromDb = await getMessagesByChatId({ id });
      }
    } else if (message?.role === "user") {
      // Chat is created during sprint preparation for sprint chats,
      // or here for fresh chats without sprints.
      await saveChat({
        id,
        userId: session.user.id,
        title: "New chat",
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    const uiMessages = isToolApprovalFlow
      ? (messages as ChatMessage[])
      : [...convertToUIMessages(messagesFromDb), message as ChatMessage];

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            chatId: id,
            id: message.id,
            role: "user",
            parts: message.parts,
            attachments: [],
            createdAt: new Date(),
          },
        ],
      });
    }

    const isReasoningModel =
      selectedChatModel.endsWith("-thinking") ||
      (selectedChatModel.includes("reasoning") &&
        !selectedChatModel.includes("non-reasoning"));

    const modelMessages = await convertToModelMessages(uiMessages);

    // Resolve sprint context — pre-built during preparation and stored on chat record
    const memwalKey = session.user.privateKey || process.env.MEMWAL_KEY;
    const memwalAccountId = session.user.accountId || process.env.MEMWAL_ACCOUNT_ID;
    const resolvedSprintIds: string[] = chat?.sprintIds ?? [];
    const prebuiltSprintContext: string | null = chat?.sprintContext ?? null;

    console.log(`[sprint:context] resolvedSprintIds=${JSON.stringify(resolvedSprintIds)}, memwalKey=${memwalKey ? "present" : "missing"}, prebuiltContext=${prebuiltSprintContext ? `${prebuiltSprintContext.length} chars` : "none"}`);

    let systemPrompt = researchPrompt;
    if (prebuiltSprintContext) {
      // Use pre-built context from sprint preparation (LLM-generated queries → MemWal recall)
      systemPrompt = getSprintResumePrompt(prebuiltSprintContext);
      console.log(`[sprint:context] Using pre-built sprint context: ${prebuiltSprintContext.length} chars`);
      console.log(`[sprint:context] Final system prompt length=${systemPrompt.length} chars (base=${researchPrompt.length}, sprint addition=${systemPrompt.length - researchPrompt.length})`);
    } else if (resolvedSprintIds.length > 0) {
      // Fallback for chats created before sprint preparation existed — build lightweight metadata context
      const { systemPromptBlock, sprintCount } = await buildSprintContext({
        sprintIds: resolvedSprintIds,
        userId: session.user.id,
      });
      console.log(`[sprint:context] Fallback: buildSprintContext returned ${sprintCount} sprints, block length=${systemPromptBlock.length} chars`);
      if (systemPromptBlock) {
        systemPrompt = getSprintResumePrompt(systemPromptBlock);
        console.log(`[sprint:context] Final system prompt length=${systemPrompt.length} chars (base=${researchPrompt.length}, sprint addition=${systemPrompt.length - researchPrompt.length})`);
      }
    }

    const hasRecallTool = resolvedSprintIds.length > 0 && !!memwalKey;
    console.log(`[sprint:tools] recallSprint tool ${hasRecallTool ? "ENABLED" : "disabled"}`);

    const researchTools = getResearchTools({
      userId: session.user.id,
      memwalKey: hasRecallTool ? memwalKey : undefined,
      accountId: hasRecallTool ? memwalAccountId : undefined,
    });

    const stream = createUIMessageStream({
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
      execute: async ({ writer: dataStream }) => {
        // --- Detect and process sources before AI responds ---
        if (message?.role === "user") {
          const sources: SourceInput[] = [];

          // Extract URLs from text parts
          for (const part of message.parts) {
            if (part.type === "text" && part.text) {
              const urls = extractUrlsFromText(part.text);
              for (const url of urls) {
                sources.push({ type: "url", url });
              }
            }
          }

          // Find PDF file parts
          for (const part of message.parts) {
            if (
              part.type === "file" &&
              (part as { mediaType?: string }).mediaType === "application/pdf"
            ) {
              const filePart = part as { url: string; name: string };
              sources.push({
                type: "pdf",
                fileUrl: filePart.url,
                fileName: filePart.name,
              });
            }
          }

          if (sources.length > 0) {
            let processedCount = 0;

            for (const source of sources) {
              const label =
                source.type === "url"
                  ? source.url
                  : (source as { fileName: string }).fileName;

              dataStream.write({
                type: "data-source-processing",
                data: { label },
                transient: true,
              });

              try {
                const result = await processSource({
                  source,
                  userId: session.user.id,
                });
                dataStream.write({
                  type: "data-source-processed",
                  data: {
                    title: result.title,
                    chunkCount: result.chunkCount,
                    sourceId: result.sourceId,
                  },
                  transient: true,
                });
                processedCount++;
              } catch (error) {
                console.error("Source processing error:", error);
                dataStream.write({
                  type: "data-source-error",
                  data: {
                    label,
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to process source",
                  },
                  transient: true,
                });
              }
            }

            dataStream.write({
              type: "data-sources-done",
              data: { count: processedCount },
              transient: true,
            });
          }
        }

        // --- Stream AI response ---
        const baseTools = [
          "listSources",
          "searchSourceContent",
          "getChunkContent",
          "getSourceContext",
        ] as const;

        const activeToolNames =
          resolvedSprintIds.length > 0 && memwalKey
            ? ([...baseTools, "recallSprint"] as const)
            : baseTools;

        const result = streamText({
          model: getLanguageModel(selectedChatModel),
          system: systemPrompt,
          messages: modelMessages,
          stopWhen: stepCountIs(10),
          experimental_activeTools: isReasoningModel ? [] : [...activeToolNames],
          tools: researchTools,
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: "stream-text",
          },
        });

        dataStream.merge(
          result.toUIMessageStream({ sendReasoning: isReasoningModel })
        );

        if (titlePromise) {
          const title = await titlePromise;
          dataStream.write({ type: "data-chat-title", data: title });
          updateChatTitleById({ chatId: id, title });
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          for (const finishedMsg of finishedMessages) {
            const existingMsg = uiMessages.find((m) => m.id === finishedMsg.id);
            if (existingMsg) {
              await updateMessage({
                id: finishedMsg.id,
                parts: finishedMsg.parts,
              });
            } else {
              await saveMessages({
                messages: [
                  {
                    id: finishedMsg.id,
                    role: finishedMsg.role,
                    parts: finishedMsg.parts,
                    createdAt: new Date(),
                    attachments: [],
                    chatId: id,
                  },
                ],
              });
            }
          }
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              id: currentMessage.id,
              role: currentMessage.role,
              parts: currentMessage.parts,
              createdAt: new Date(),
              attachments: [],
              chatId: id,
            })),
          });
        }
      },
      onError: (error) => {
        if (
          error instanceof Error &&
          error.message?.includes(
            "AI Gateway requires a valid credit card on file to service requests"
          )
        ) {
          return "AI Gateway requires a valid credit card on file to service requests.";
        }
        return "Oops, an error occurred!";
      },
    });

    return createUIMessageStreamResponse({
      stream,
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ streamId, chatId: id });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch (_) {
          // ignore redis errors
        }
      },
    });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    console.error("Unhandled error in chat API:", error);
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await getSession();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
