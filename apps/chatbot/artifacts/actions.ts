"use server";

import { auth } from "@/app/(auth)/auth";
import { getSuggestionsByDocumentIdForUser } from "@/lib/db/queries";

export async function getSuggestions({ documentId }: { documentId: string }) {
  const session = await auth();
  const userId = session?.user?.id;
  // No authenticated user id → same empty shape as a missing document, so
  // existence of another user's suggestions is not disclosed.
  if (!userId) {
    return [];
  }

  const suggestions = await getSuggestionsByDocumentIdForUser({
    documentId,
    userId,
  });
  // Defense in depth: even though the lookup is owner-scoped, drop any row
  // that somehow isn't the caller's so a future query refactor cannot
  // silently reopen the IDOR.
  return (suggestions ?? []).filter((row) => row.userId === userId);
}
