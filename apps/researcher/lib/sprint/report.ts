import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import { getLanguageModel } from "@/lib/ai/providers";
import { getMessagesByChatId } from "@/lib/db/queries";
import { buildChunkManifest } from "./manifest";
import type { SprintReport } from "./types";

const REPORT_MODEL = "google/gemini-2.5-flash";
const MAX_TRANSCRIPT_CHARS = 30_000;

const citationSchema = z.object({
  refIndex: z.number().describe("Citation reference number, starting from 1"),
  sourceId: z.string().describe("The source ID this citation refers to"),
  sourceTitle: z.string().describe("Title of the source"),
  sourceUrl: z.string().nullable().describe("URL of the source, or null"),
  section: z
    .string()
    .describe("Section heading within the source document"),
  supportingChunks: z
    .array(z.string())
    .describe("Chunk IDs that support this citation"),
  scope: z
    .string()
    .describe("Brief description of what this citation covers"),
});

const reportSchema = z.object({
  title: z.string().describe("Concise title for the research sprint"),
  summary: z
    .string()
    .describe("2-3 sentence summary of key findings"),
  content: z
    .string()
    .describe(
      "Full markdown report with [N] inline citation references. Use [1], [2], etc."
    ),
  citations: z
    .array(citationSchema)
    .describe("Ordered list of citations referenced in the content"),
});

/**
 * Generate a structured research sprint report from chat history and chunk manifest.
 */
export async function generateSprintReport({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}): Promise<SprintReport> {
  console.log(`[sprint:report] Starting report generation for chat=${chatId}`);

  // Run manifest build and message fetch in parallel
  const [manifest, messages] = await Promise.all([
    buildChunkManifest({ chatId, userId }),
    getMessagesByChatId({ id: chatId }),
  ]);

  console.log(
    `[sprint:report] Manifest: ${manifest.length} chunks, Messages: ${messages.length}`
  );

  // Build simplified chat transcript (text parts only)
  let transcript = "";
  for (const msg of messages) {
    const parts = msg.parts as { type: string; text?: string }[];
    if (!Array.isArray(parts)) continue;

    const textParts = parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");

    if (textParts) {
      transcript += `[${msg.role}]: ${textParts}\n\n`;
    }
  }

  // Truncate transcript if too long
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n...[truncated]";
  }

  // Build manifest reference for the LLM
  const manifestRef = manifest
    .map(
      (m) =>
        `- chunkId=${m.chunkId} | source="${m.sourceTitle ?? "Untitled"}" (${m.sourceUrl ?? "no url"}) | section="${m.section}" | idx=${m.chunkIndex}\n  preview: ${m.preview}`
    )
    .join("\n");

  const { object } = await generateObject({
    model: getLanguageModel(REPORT_MODEL),
    schema: reportSchema,
    prompt: `You are a research report generator. Analyze the following chat conversation and source chunk manifest to produce a structured research report.

INSTRUCTIONS:
- Write a comprehensive report summarizing the research findings from this chat session.
- The content should be well-structured markdown with headers, paragraphs, and bullet points as appropriate.
- Focus on key findings, analysis, and conclusions from the research.
${manifest.length > 0
  ? `- Use [N] inline citations to reference specific sources. Each citation should map to a real chunk from the manifest.
- Only cite sources that appear in the manifest below. Do not fabricate citations.`
  : `- The chunk manifest is empty, meaning no source chunks were directly accessed. Do NOT include any [N] citation references in the report. Write the report based on the conversation content only. Return an empty citations array.`}

CHUNK MANIFEST (sources the researcher accessed):
${manifestRef || "(empty — no chunks were accessed)"}

CHAT TRANSCRIPT:
${transcript}`,
  });

  // Post-validate: filter citations to only those referencing real manifest chunks
  const validChunkIds = new Set(manifest.map((m) => m.chunkId));
  const validatedCitations = object.citations.filter((c) =>
    c.supportingChunks.some((id) => validChunkIds.has(id))
  );

  console.log(
    `[sprint:report] Generated report: "${object.title}" — ${validatedCitations.length}/${object.citations.length} valid citations`
  );

  return {
    title: object.title,
    summary: object.summary,
    content: object.content,
    citations: validatedCitations,
  };
}
