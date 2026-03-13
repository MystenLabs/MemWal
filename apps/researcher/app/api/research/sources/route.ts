import { getSession } from "@/lib/auth/session";
import { getSourcesByUserId } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

export async function GET() {
  const session = await getSession();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const sources = await getSourcesByUserId({ userId: session.user.id });

  return Response.json(sources);
}
