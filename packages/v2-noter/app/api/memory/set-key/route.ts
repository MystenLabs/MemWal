/**
 * Set MemWal Key API — allows user to set their MEMWAL_KEY at runtime
 */

import { setMemWalKey } from "@/feature/note/lib/pdw-client";

export async function POST(req: Request) {
    try {
        const { key } = await req.json();

        if (typeof key !== "string") {
            return Response.json({ error: "key must be a string" }, { status: 400 });
        }

        setMemWalKey(key || null);

        if (!key) {
            return Response.json({ status: "cleared" });
        }

        return Response.json({ status: "ok" });
    } catch (error) {
        console.error("[memory/set-key] Error:", error);
        return Response.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 }
        );
    }
}
