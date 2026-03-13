import { getSession } from "@/lib/auth/session";
import { getSprintsByUserId } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

export async function GET() {
  const session = await getSession();
  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  try {
    const sprints = await getSprintsByUserId({ userId: session.user.id });
    return Response.json(sprints);
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }
    console.error("[api:sprint/list] Error:", error);
    return new ChatbotError(
      "bad_request:api",
      "Failed to fetch sprints"
    ).toResponse();
  }
}
