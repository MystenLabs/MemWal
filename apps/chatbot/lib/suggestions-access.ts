import { ChatbotError } from "@/lib/errors";
import { getSuggestionsByDocumentId } from "@/lib/db/queries";
import type { Suggestion } from "@/lib/db/schema";

/**
 * Load suggestions for a document only if they belong to `userId`.
 *
 * The HTTP GET /api/suggestions route already did this (auth +
 * `suggestion.userId === session.user.id`). The `getSuggestions` server
 * action did not — it returned any document's rows to whoever posted the
 * action id (WALM-461). Shared here so the two surfaces cannot drift.
 */
export async function getSuggestionsForUser({
  documentId,
  userId,
}: {
  documentId: string;
  userId: string;
}): Promise<Suggestion[]> {
  const suggestions = await getSuggestionsByDocumentId({ documentId });
  const [suggestion] = suggestions;

  if (!suggestion) {
    return [];
  }

  if (suggestion.userId !== userId) {
    throw new ChatbotError("forbidden:api");
  }

  return suggestions;
}
