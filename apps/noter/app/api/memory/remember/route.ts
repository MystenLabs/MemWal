/**
 * Memory Remember API — analyzes note text and extracts facts to MemWal
 * Uses analyze() which extracts multiple facts, embeds, encrypts, and stores them server-side.
 */

import { extractMemories } from "@/feature/note/lib/pdw-client";

export async function POST(req: Request) {
    try {
        const { text } = await req.json();

        if (!text || typeof text !== "string") {
            return Response.json({ error: "text is required" }, { status: 400 });
        }

        if (text.trim().length < 10) {
            return Response.json({ error: "Text too short to analyze" }, { status: 400 });
        }

        const facts = await extractMemories("noter", text);
        return Response.json({ facts, count: facts.length });
    } catch (error) {
        console.error("[memory/remember] Error:", error);
        return Response.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 }
        );
    }
}
