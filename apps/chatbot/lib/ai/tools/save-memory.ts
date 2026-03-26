import { tool } from "ai";
import { z } from "zod";
import { MemWal } from "@mysten-incubation/memwal";

export const saveMemory = ({
  memwalKey,
  memwalAccountId,
}: {
  memwalKey?: string;
  memwalAccountId?: string;
}) =>
  tool({
    description:
      "Save information to the user's personal memory on the blockchain. ONLY use this tool when the user EXPLICITLY asks you to save or remember something (e.g., 'remember this', 'save this', 'lưu lại', 'nhớ giùm'). Do NOT use this tool proactively. Save the FULL, DETAILED content — do not summarize or shorten it.",
    inputSchema: z.object({
      text: z
        .string()
        .describe(
          "The full, detailed text to save to memory. Include all relevant details — do not summarize."
        ),
    }),
    execute: async ({ text }) => {
      const key = memwalKey || process.env.MEMWAL_KEY;
      const accountId = memwalAccountId || process.env.MEMWAL_ACCOUNT_ID;
      const serverUrl = process.env.MEMWAL_SERVER_URL || "http://localhost:8000";

      if (!key || !accountId) {
        return {
          saved: false,
          text,
          error: "MemWal not configured — MEMWAL_KEY or MEMWAL_ACCOUNT_ID missing",
        };
      }

      try {
        const memwal = MemWal.create({ key, accountId, serverUrl });
        await memwal.remember(text);
        return { saved: true, text };
      } catch (error) {
        console.error("[Tool] saveMemory error:", error);
        return {
          saved: false,
          text,
          error: error instanceof Error ? error.message : "Failed to save memory",
        };
      }
    },
  });
