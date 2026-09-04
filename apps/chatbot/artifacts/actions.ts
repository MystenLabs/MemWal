"use server";

import { auth } from "@/app/(auth)/auth";
import { ChatbotError } from "@/lib/errors";
import { getSuggestionsForUser } from "@/lib/suggestions-access";

export async function getSuggestions({ documentId }: { documentId: string }) {
  const session = await auth();

  if (!session?.user?.id) {
    throw new ChatbotError("unauthorized:suggestions");
  }

  return getSuggestionsForUser({
    documentId,
    userId: session.user.id,
  });
}
