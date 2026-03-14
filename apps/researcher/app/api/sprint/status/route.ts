import { getSession } from "@/lib/auth/session";
import { getChatById, getSprintByChatId } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

export async function GET(request: Request) {
  const session = await getSession();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId");

  if (!chatId) {
    return new ChatbotError(
      "bad_request:api",
      "Expected a chatId query parameter"
    ).toResponse();
  }

  try {
    const chat = await getChatById({ id: chatId });
    if (!chat || chat.userId !== session.user.id) {
      return new ChatbotError("forbidden:chat").toResponse();
    }

    const sprint = await getSprintByChatId({ chatId });

    return Response.json({
      hasSprint: !!sprint,
      sprintId: sprint?.id ?? null,
      title: sprint?.title ?? null,
    });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    console.error("[api:sprint/status] Error:", error);
    return new ChatbotError(
      "bad_request:api",
      "Failed to check sprint status"
    ).toResponse();
  }
}
