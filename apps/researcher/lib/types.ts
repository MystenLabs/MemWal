import type { UIMessage } from "ai";
import { z } from "zod";

export type DataPart = { type: "append-message"; message: string };

export const messageMetadataSchema = z.object({
  createdAt: z.string(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

export type CustomUIDataTypes = {
  appendMessage: string;
  "chat-title": string;
  "source-processing": { label: string };
  "source-processed": { title: string; chunkCount: number; sourceId: string };
  "source-error": { label: string; error: string };
  "sources-done": { count: number };
};

export type ChatMessage = UIMessage<
  MessageMetadata,
  CustomUIDataTypes
>;

export type Attachment = {
  name: string;
  url: string;
  contentType: string;
};
