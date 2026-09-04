import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatbotError } from "@/lib/errors";

// Regression for WALM-461: the getSuggestions server action used to return
// another user's suggestion rows (originalText / suggestedText) as long as
// the caller knew the document UUID. GET /api/suggestions already rejected
// that with auth() + suggestion.userId === session.user.id.

const OWNER_ID = "a80ba4b1-829e-4651-8fe6-da7b428192a3";
const ATTACKER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DOC_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const ownerRow = {
  documentId: DOC_ID,
  originalText: "secret draft paragraph",
  suggestedText: "rewritten secret draft",
  userId: OWNER_ID,
};

const auth = vi.fn();
const getSuggestionsByDocumentId = vi.fn(async ({ documentId }: { documentId: string }) =>
  documentId === DOC_ID ? [ownerRow] : []
);

vi.mock("@/app/(auth)/auth", () => ({ auth }));
vi.mock("@/lib/db/queries", () => ({ getSuggestionsByDocumentId }));

beforeEach(() => {
  vi.clearAllMocks();
  getSuggestionsByDocumentId.mockImplementation(
    async ({ documentId }: { documentId: string }) =>
      documentId === DOC_ID ? [ownerRow] : []
  );
});

describe("getSuggestions server action", () => {
  it("rejects an unauthenticated caller without querying", async () => {
    auth.mockResolvedValue(null);
    const { getSuggestions } = await import("./actions");

    await expect(getSuggestions({ documentId: DOC_ID })).rejects.toMatchObject({
      type: "unauthorized",
      surface: "suggestions",
    } satisfies Partial<ChatbotError>);
    expect(getSuggestionsByDocumentId).not.toHaveBeenCalled();
  });

  it("rejects a signed-in caller for another user's document", async () => {
    auth.mockResolvedValue({ user: { id: ATTACKER_ID } });
    const { getSuggestions } = await import("./actions");

    await expect(getSuggestions({ documentId: DOC_ID })).rejects.toMatchObject({
      type: "forbidden",
      surface: "api",
    } satisfies Partial<ChatbotError>);
    expect(getSuggestionsByDocumentId).toHaveBeenCalledWith({
      documentId: DOC_ID,
    });
  });

  it("returns the owner's rows to the owner", async () => {
    auth.mockResolvedValue({ user: { id: OWNER_ID } });
    const { getSuggestions } = await import("./actions");

    await expect(getSuggestions({ documentId: DOC_ID })).resolves.toEqual([
      ownerRow,
    ]);
  });

  it("returns an empty list when the document has no suggestions", async () => {
    auth.mockResolvedValue({ user: { id: OWNER_ID } });
    getSuggestionsByDocumentId.mockResolvedValue([]);
    const { getSuggestions } = await import("./actions");

    await expect(
      getSuggestions({ documentId: "dddddddd-dddd-dddd-dddd-dddddddddddd" })
    ).resolves.toEqual([]);
  });
});
