import type { InferUITool, UIMessage } from "ai";
import { z } from "zod";
import type { getResearchTools } from "./ai/tools/research-tools";

export type DataPart = { type: "append-message"; message: string };

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

type ResearchTools = ReturnType<typeof getResearchTools>;

export type ChatTools = {
  [K in keyof ResearchTools]: InferUITool<ResearchTools[K]>;
};

export type CustomUIDataTypes = {
  appendMessage: string;
  "chat-title": string;
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes,
  ChatTools
>;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
};
