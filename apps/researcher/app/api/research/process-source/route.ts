import { generateObject } from "ai";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { chunkDocument } from "@/lib/ai/chunking";
import { batchEmbed } from "@/lib/ai/embeddings";
import { getLanguageModel } from "@/lib/ai/providers";
import { createSource, createSourceChunks } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { extractText } from "unpdf";

export const maxDuration = 120; // source processing can take a while

const JINA_READER_URL = "https://r.jina.ai/";
const CHUNK_EXPIRY_DAYS = 7;
const SUMMARY_MODEL = "google/gemini-2.5-flash";

const summarySchema = z.object({
  title: z.string().describe("Document title or generated title"),
  summary: z
    .string()
    .describe("2-3 sentence summary of the document's main points"),
  claims: z
    .array(z.string())
    .describe("3-8 key claims or findings from the document"),
});

// --- Content extraction ---

async function extractFromUrl(url: string): Promise<string> {
  const response = await fetch(`${JINA_READER_URL}${url}`, {
    headers: { Accept: "text/markdown" },
  });

  if (!response.ok) {
    throw new ChatbotError(
      "bad_request:api",
      `Jina Reader failed to extract content from URL: ${response.statusText}`
    );
  }

  const text = await response.text();
  if (!text || text.trim().length === 0) {
    throw new ChatbotError(
      "bad_request:api",
      "Extracted content is empty"
    );
  }

  return text;
}

async function extractFromPdf(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const result = await extractText(buffer, { mergePages: true });

  const text =
    typeof result.text === "string"
      ? result.text
      : Array.isArray(result.text)
        ? result.text.join("\n")
        : String(result.text);

  if (!text || text.trim().length === 0) {
    throw new ChatbotError(
      "bad_request:api",
      "Could not extract text from this PDF. It may be image-based (scanned/designed). Please use a text-based PDF or paste the content as a URL instead."
    );
  }

  return text;
}

// --- Metadata generation ---

async function generateSourceMetadata(
  text: string
): Promise<z.infer<typeof summarySchema>> {
  // Use first ~8K chars for summary to avoid massive token usage
  const previewText = text.slice(0, 8000);

  const { object } = await generateObject({
    model: getLanguageModel(SUMMARY_MODEL),
    schema: summarySchema,
    prompt: `Analyze this document and provide a title, summary, and key claims.

---
${previewText}
---`,
  });

  return object;
}

// --- API handler ---

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const userId = session.user.id;

  try {
    const contentType = request.headers.get("content-type") || "";

    let type: "url" | "pdf";
    let rawText: string;
    let originalUrl: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      // PDF upload
      const formData = await request.formData();
      const file = formData.get("file") as File | null;

      if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
        return new ChatbotError(
          "bad_request:api",
          "Expected a PDF file"
        ).toResponse();
      }

      type = "pdf";
      rawText = await extractFromPdf(file);
    } else {
      // URL submission
      const body = await request.json();
      const url = body?.url;

      if (!url || typeof url !== "string") {
        return new ChatbotError(
          "bad_request:api",
          "Expected a url field"
        ).toResponse();
      }

      // Basic URL validation
      try {
        new URL(url);
      } catch {
        return new ChatbotError(
          "bad_request:api",
          "Invalid URL format"
        ).toResponse();
      }

      type = "url";
      originalUrl = url;
      rawText = await extractFromUrl(url);
    }

    // Run chunking and metadata generation in parallel
    const [metadata, chunks] = await Promise.all([
      generateSourceMetadata(rawText),
      chunkDocument(rawText, ""),
    ]);

    // Embed all chunks
    const chunkTexts = chunks.map((c) => `${c.section}\n\n${c.content}`);
    const embeddings = await batchEmbed(chunkTexts);

    // Create source record
    const expiresAt = new Date(
      Date.now() + CHUNK_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );

    const sourceRecord = await createSource({
      userId,
      type,
      title: metadata.title,
      url: originalUrl,
      summary: metadata.summary,
      claims: metadata.claims,
      chunkCount: chunks.length,
    });

    // Store chunks with embeddings
    if (chunks.length > 0) {
      await createSourceChunks({
        chunks: chunks.map((chunk, i) => ({
          sourceId: sourceRecord.id,
          section: chunk.section,
          content: chunk.content,
          embedding: embeddings[i],
          expiresAt,
        })),
      });
    }

    return Response.json(
      {
        sourceId: sourceRecord.id,
        title: metadata.title,
        type,
        url: originalUrl ?? null,
        summary: metadata.summary,
        claims: metadata.claims,
        chunkCount: chunks.length,
        expiresAt: expiresAt.toISOString(),
        createdAt: sourceRecord.createdAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    console.error("Source processing error:", error);
    return new ChatbotError(
      "bad_request:api",
      "Failed to process source"
    ).toResponse();
  }
}
