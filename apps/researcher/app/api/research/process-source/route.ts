import { getSession } from "@/lib/auth/session";
import { processSource } from "@/lib/rag";
import {
  MAX_JSON_BODY_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  assertSourceFileWithinBudget,
  readCappedRequestBody,
} from "@/lib/rag/ingest/limits";
import { ChatbotError } from "@/lib/errors";
import { checkIngestRateLimit, getClientIp } from "@/lib/ratelimit";

export const maxDuration = 120; // source processing can take a while

export async function POST(request: Request) {
  const session = await getSession();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const userId = session.user.id;

  try {
    // Ingestion is the most expensive thing an authenticated user can ask for —
    // PDF parsing, metadata generation, and one embedding call per batch. The
    // limiter runs before a single body byte is read, and on its own bucket so
    // uploads do not spend the caller's chat quota (WALM-683).
    //
    // This route is kept out of proxy.ts's matcher on purpose. Next clones and
    // drains the body of every request the proxy sees, to EOF, before the route
    // runs — and truncates what the route receives at proxyClientMaxBodySize —
    // so no check in here could stop an oversized upload from being read. Out
    // of the proxy, the route owns the raw stream and can refuse it early.
    await checkIngestRateLimit(getClientIp(request));

    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      // PDF upload. The raw body is read under the byte budget first and only
      // then parsed, so the budget applies to what arrives on the wire rather
      // than to a File that is already fully buffered.
      const body = await readCappedRequestBody(request, MAX_UPLOAD_BODY_BYTES);
      const formData = await new Response(body, {
        headers: { "content-type": contentType },
      }).formData();
      // A cast is not a check: `formData.get("file") as File` accepted a plain
      // text field. The size check here is a second line behind the read cap.
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
      // URL submission: one small JSON object, capped like the upload branch
      // rather than handed to request.json(), which reads whatever is sent.
      const raw = await readCappedRequestBody(request, MAX_JSON_BODY_BYTES);
      let body: { url?: unknown } | null;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return new ChatbotError(
          "bad_request:api",
          "Expected a JSON body with a url field"
        ).toResponse();
      }
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
