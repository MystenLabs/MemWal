/**
 * Memory Remember API — extracts facts and stores them under the authenticated
 * user's Walrus Memory account. No server-wide credential fallback is allowed.
 */

import { extractMemories } from "@/feature/note/lib/pdw-client";
import {
  authorizeMemoryRequest,
  memoryErrorResponse,
  readMemoryText,
} from "@/feature/note/api/memory-request";

export async function POST(req: Request) {
  try {
    // Authenticate and rate-limit before parsing or analyzing attacker input.
    const { key, accountId } = await authorizeMemoryRequest(req);
    const text = await readMemoryText(req);

    if (text.trim().length < 10) {
      return Response.json(
        { error: "Text too short to analyze" },
        { status: 400 }
      );
    }

    const facts = await extractMemories("noter", text, key, accountId);
    return Response.json({ facts, count: facts.length });
  } catch (error) {
    const expected = memoryErrorResponse(error);
    if (expected) return expected;

    console.error("[memory/remember] Error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
