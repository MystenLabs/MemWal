import { generateObject } from "ai";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { getSprintsByIds } from "@/lib/db/queries";
import { getTitleModel } from "@/lib/ai/providers";
import { ChatbotError } from "@/lib/errors";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  try {
    const { sprintIds } = (await request.json()) as { sprintIds: string[] };

    if (!sprintIds?.length) {
      return Response.json({ greeting: "", suggestions: [] });
    }

    const sprints = await getSprintsByIds({
      sprintIds,
      userId: session.user.id,
    });

    if (sprints.length === 0) {
      return Response.json({ greeting: "", suggestions: [] });
    }

    const sprintContext = sprints
      .map(
        (s) =>
          `Title: ${s.title}\nSummary: ${s.summary ?? "N/A"}\nTags: ${(s.tags ?? []).join(", ")}\nSources: ${s.sources?.length ?? 0}`
      )
      .join("\n---\n");

    const { object } = await generateObject({
      model: getTitleModel(),
      schema: z.object({
        greeting: z
          .string()
          .describe(
            "A short, warm, friendly greeting (1-2 sentences) that briefly summarizes what research knowledge is available. Speak casually like a helpful colleague."
          ),
        suggestions: z
          .array(z.string())
          .min(3)
          .max(4)
          .describe("3-4 short suggested questions the user might ask"),
      }),
      prompt: `You are a friendly research assistant. The user just opened a chat with the following sprint research loaded.

${sprintContext}

Generate:
1. A short, warm greeting (1-2 sentences max) that briefly tells the user what research you have context on. Be conversational and friendly — like a colleague who just finished reading through their materials. Don't say "Hello" or "Hi" — jump straight into what you know. Example tone: "I've gone through your research on X and Y — got a solid picture of the key findings and ${sprints.length > 1 ? "how they connect" : "what stands out"}."
2. 3-4 short, specific suggested questions (under 60 characters each) the user might want to ask. Make them diverse — cover key findings, comparisons, implications, and practical applications.`,
    });

    return Response.json(object);
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }
    console.error("[api:sprint/suggestions] Error:", error);
    return new ChatbotError(
      "bad_request:api",
      "Failed to generate suggestions"
    ).toResponse();
  }
}
