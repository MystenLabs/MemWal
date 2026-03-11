import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import { getLanguageModel } from "@/lib/ai/providers";

export const SUMMARY_MODEL = "google/gemini-2.5-flash";

export const summarySchema = z.object({
  title: z.string().describe("Document title or generated title"),
  summary: z
    .string()
    .describe("2-3 sentence summary of the document's main points"),
  claims: z
    .array(z.string())
    .describe("3-8 key claims or findings from the document"),
});

export async function generateSourceMetadata(
  text: string
): Promise<z.infer<typeof summarySchema>> {
  const previewText = text.slice(0, 8000);

  const { object } = await generateObject({
    model: getLanguageModel(SUMMARY_MODEL),
    schema: summarySchema,
    prompt: `Analyze this document and provide a title, summary, and key claims.

---
${previewText}
---`,
  });

  return object;
}
