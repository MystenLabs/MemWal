import { auth } from "@/app/(auth)/auth";
import { getSuggestionsByDocumentIdForUser } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

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
  const userId = session?.user?.id;

  if (!userId) {
    return new ChatbotError("unauthorized:suggestions").toResponse();
  }

  const suggestions = await getSuggestionsByDocumentIdForUser({
    documentId,
    userId,
  });

  // Owner-scoped lookup already dropped other users' rows. Re-assert so a
  // future query refactor cannot leak suggestion text through this route.
  if (suggestions.some((suggestion) => suggestion.userId !== userId)) {
    return new ChatbotError("forbidden:api").toResponse();
  }

  return Response.json(suggestions, { status: 200 });
}
