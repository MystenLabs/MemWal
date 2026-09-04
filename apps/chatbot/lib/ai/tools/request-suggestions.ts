import { Output, streamText, tool, type UIMessageStreamWriter } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { getDocumentByIdForUser, saveSuggestions } from "@/lib/db/queries";
import type { Suggestion } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";
import { MAX_OUTPUT_TOKENS } from "../models";
import { getArtifactModel } from "../providers";

type RequestSuggestionsProps = {
  session: Session;
  dataStream: UIMessageStreamWriter<ChatMessage>;
};

export const requestSuggestions = ({
  session,
  dataStream,
}: RequestSuggestionsProps) =>
  tool({
    description:
      "Request writing suggestions for an existing document artifact. Only use this when the user explicitly asks to improve or get suggestions for a document they have already created. Never use for general questions.",
    inputSchema: z.object({
      documentId: z
        .string()
        .describe(
          "The UUID of an existing document artifact that was previously created with createDocument"
        ),
    }),
    execute: async ({ documentId }) => {
      // No authenticated user id means no document can belong to the caller.
      // Bail out with the same "not found" shape rather than passing an empty
      // string into the userId filter (a UUID-typed column), which would throw.
      const userId = session.user?.id;
      if (!userId) {
        return {
          error: "Document not found",
        };
      }

      // Scope the lookup to the calling user so this tool cannot read another
      // user's document content — mirrors the ownership check the HTTP route
      // (app/(chat)/api/document/route.ts) enforces on the same resource.
      const document = await getDocumentByIdForUser({
        id: documentId,
        userId,
      });

      // Defense in depth: re-assert ownership after the scoped lookup so a
      // future refactor cannot reopen the gap. Non-owners get the same
      // "not found" shape as a missing id.
      if (!document || document.userId !== userId || !document.content) {
        return {
          error: "Document not found",
        };
      }

      const suggestions: Omit<
        Suggestion,
        "userId" | "createdAt" | "documentCreatedAt"
      >[] = [];

      const { partialOutputStream } = streamText({
        model: getArtifactModel(),
        system:
          "You are a help writing assistant. Given a piece of writing, please offer suggestions to improve the piece of writing and describe the change. It is very important for the edits to contain full sentences instead of just words. Max 5 suggestions.",
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        prompt: document.content,
        output: Output.array({
          element: z.object({
            originalSentence: z.string().describe("The original sentence"),
            suggestedSentence: z.string().describe("The suggested sentence"),
            description: z
              .string()
              .describe("The description of the suggestion"),
          }),
        }),
      });

      let processedCount = 0;
      for await (const partialOutput of partialOutputStream) {
        if (!partialOutput) {
          continue;
        }

        for (let i = processedCount; i < partialOutput.length; i++) {
          const element = partialOutput[i];
          if (
            !element?.originalSentence ||
            !element?.suggestedSentence ||
            !element?.description
          ) {
            continue;
          }

          const suggestion = {
            originalText: element.originalSentence,
            suggestedText: element.suggestedSentence,
            description: element.description,
            id: generateUUID(),
            documentId,
            isResolved: false,
          };

          dataStream.write({
            type: "data-suggestion",
            data: suggestion as Suggestion,
            transient: true,
          });

          suggestions.push(suggestion);
          processedCount++;
        }
      }

      await saveSuggestions({
        suggestions: suggestions.map((suggestion) => ({
          ...suggestion,
          userId,
          createdAt: new Date(),
          documentCreatedAt: document.createdAt,
        })),
      });

      return {
        id: documentId,
        title: document.title,
        kind: document.kind,
        message: "Suggestions have been added to the document",
      };
    },
  });
