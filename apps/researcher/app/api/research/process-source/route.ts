import { auth } from "@/app/(auth)/auth";
import { processSource } from "@/lib/rag";
import { ChatbotError } from "@/lib/errors";

export const maxDuration = 120; // source processing can take a while

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const userId = session.user.id;

  try {
    const contentType = request.headers.get("content-type") || "";

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

      const result = await processSource({
        source: { type: "pdf-file", file },
        userId,
      });

      return Response.json(
        {
          sourceId: result.sourceId,
          title: result.title,
          type: result.type,
          url: result.url ?? null,
          summary: result.summary,
          claims: result.claims,
          chunkCount: result.chunkCount,
          expiresAt: result.expiresAt,
          createdAt: result.createdAt,
        },
        { status: 201 }
      );
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

      try {
        new URL(url);
      } catch {
        return new ChatbotError(
          "bad_request:api",
          "Invalid URL format"
        ).toResponse();
      }

      const result = await processSource({
        source: { type: "url", url },
        userId,
      });

      return Response.json(
        {
          sourceId: result.sourceId,
          title: result.title,
          type: result.type,
          url: result.url ?? null,
          summary: result.summary,
          claims: result.claims,
          chunkCount: result.chunkCount,
          expiresAt: result.expiresAt,
          createdAt: result.createdAt,
        },
        { status: 201 }
      );
    }
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
