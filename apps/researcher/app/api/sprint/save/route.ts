import { getSession } from "@/lib/auth/session";
import { saveSprint } from "@/lib/sprint";
import { ChatbotError } from "@/lib/errors";

export const maxDuration = 120;

export async function POST(request: Request) {
  const session = await getSession();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const userId = session.user.id;

  try {
    const body = await request.json();
    const { chatId } = body;

    if (!chatId || typeof chatId !== "string") {
      return new ChatbotError(
        "bad_request:api",
        "Expected a chatId field"
      ).toResponse();
    }

    const key = session.user.privateKey || process.env.MEMWAL_KEY;
    if (!key) {
      return new ChatbotError(
        "bad_request:api",
        "No MemWal key provided"
      ).toResponse();
    }

    const result = await saveSprint({ chatId, userId, memwalKey: key });

    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    console.error("[api:sprint/save] Error:", error);
    return new ChatbotError(
      "bad_request:api",
      "Failed to save sprint"
    ).toResponse();
  }
}
