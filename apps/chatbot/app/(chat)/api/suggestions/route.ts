import { auth } from "@/app/(auth)/auth";
import { ChatbotError } from "@/lib/errors";
import { getSuggestionsForUser } from "@/lib/suggestions-access";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const documentId = searchParams.get("documentId");

  if (!documentId) {
    return new ChatbotError(
      "bad_request:api",
      "Parameter documentId is required."
    ).toResponse();
  }

  const session = await auth();

  if (!session?.user?.id) {
    return new ChatbotError("unauthorized:suggestions").toResponse();
  }

  try {
    const suggestions = await getSuggestionsForUser({
      documentId,
      userId: session.user.id,
    });
    return Response.json(suggestions, { status: 200 });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }
    throw error;
  }
}
