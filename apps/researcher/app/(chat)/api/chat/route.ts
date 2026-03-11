// Vercel-specific — only used when running on Vercel
const isVercel = !!process.env.VERCEL;
const vercelFunctions = isVercel ? require("@vercel/functions") : null;
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
} from "ai";
// BotId is Vercel-only
const checkBotId = isVercel ? require("botid/server").checkBotId : async () => ({ isBot: false });
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { allowedModelIds } from "@/lib/ai/models";
import { researchPrompt } from "@/lib/ai/prompts";
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
import { checkIpRateLimit } from "@/lib/ratelimit";
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

    const [botResult, session] = await Promise.all([checkBotId(), auth()]);

    if (botResult.isBot) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    if (!allowedModelIds.has(selectedChatModel)) {
      return new ChatbotError("bad_request:api").toResponse();
    }

    if (isVercel) {
      await checkIpRateLimit(vercelFunctions.ipAddress(request));
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 1,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
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
    const researchTools = getResearchTools({ userId: session.user.id });

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
        const result = streamText({
          model: getLanguageModel(selectedChatModel),
          system: researchPrompt,
          messages: modelMessages,
          stopWhen: stepCountIs(5),
          experimental_activeTools: isReasoningModel
            ? []
            : ["listSources", "searchSourceContent", "getChunkContent", "getSourceContext"],
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
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

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
