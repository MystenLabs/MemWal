import { getSession } from "@/lib/auth/session";
import { processSource } from "@/lib/rag";
import { assertSourceFileWithinBudget } from "@/lib/rag/ingest/limits";
import { ChatbotError } from "@/lib/errors";
import { checkIpRateLimit, getClientIp } from "@/lib/ratelimit";

export const maxDuration = 120; // source processing can take a while

export async function POST(request: Request) {
  const session = await getSession();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const userId = session.user.id;

  try {
    // Ingestion is the most expensive thing an authenticated user can ask for —
    // PDF parsing, metadata generation, and one embedding call per batch — and
    // this route had no limiter at all. The chat and auth routes already use
    // this one; it was simply never wired here (WALM-683). `maxDuration` bounds
    // a single request, not how many a caller may start.
    await checkIpRateLimit(getClientIp(request));

    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      // PDF upload
      const formData = await request.formData();
      // A cast is not a check: `formData.get("file") as File` accepted a plain
      // text field, which then reached `.name` as undefined. Size is enforced
      // here as well, before the body is buffered and parsed.
      const file = assertSourceFileWithinBudget(formData.get("file"));

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
