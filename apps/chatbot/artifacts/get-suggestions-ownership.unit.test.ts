import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the getSuggestions IDOR (WALM-438 / GH #786).
// The server action used to call an unscoped by-documentId lookup with no
// session check, so guest B could read guest A's suggestion text. The HTTP
// route already rejected that; the action did not.
//
// Two layers, both proven here:
//   1. Auth guard — no session / no user id returns [] and never queries.
//   2. Call-site re-check — even if the DB layer returns a victim row, the
//      action strips it so existence/text is not disclosed.

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const ATTACKER_ID = "22222222-2222-2222-2222-222222222222";
const DOC_ID = "33333333-3333-3333-3333-333333333333";

const ownerRow = {
  documentId: DOC_ID,
  originalText: "secret draft paragraph",
  suggestedText: "rewritten secret draft",
  userId: OWNER_ID,
};

const auth = vi.fn();
const getSuggestionsByDocumentIdForUser = vi.fn();

vi.mock("@/app/(auth)/auth", () => ({ auth }));
vi.mock("@/lib/db/queries", () => ({
  getSuggestionsByDocumentIdForUser,
}));

beforeEach(() => {
  vi.clearAllMocks();
  getSuggestionsByDocumentIdForUser.mockResolvedValue([]);
});

describe("getSuggestions ownership", () => {
  it("returns [] and does not query when there is no session", async () => {
    auth.mockResolvedValue(null);
    const { getSuggestions } = await import("./actions");

    await expect(getSuggestions({ documentId: DOC_ID })).resolves.toEqual([]);
    expect(getSuggestionsByDocumentIdForUser).not.toHaveBeenCalled();
  });

  it("returns [] and does not query when the session has no user id", async () => {
    auth.mockResolvedValue({ user: {}, expires: "" });
    const { getSuggestions } = await import("./actions");

    await expect(getSuggestions({ documentId: DOC_ID })).resolves.toEqual([]);
    expect(getSuggestionsByDocumentIdForUser).not.toHaveBeenCalled();
  });

  it("returns the caller's rows", async () => {
    auth.mockResolvedValue({ user: { id: OWNER_ID }, expires: "" });
    getSuggestionsByDocumentIdForUser.mockResolvedValue([ownerRow]);
    const { getSuggestions } = await import("./actions");

    await expect(getSuggestions({ documentId: DOC_ID })).resolves.toEqual([
      ownerRow,
    ]);
    expect(getSuggestionsByDocumentIdForUser).toHaveBeenCalledWith({
      documentId: DOC_ID,
      userId: OWNER_ID,
    });
  });

  it("does not return another user's suggestion text even if the query leaks it", async () => {
    auth.mockResolvedValue({ user: { id: ATTACKER_ID }, expires: "" });
    getSuggestionsByDocumentIdForUser.mockResolvedValue([ownerRow]);
    const { getSuggestions } = await import("./actions");

    await expect(getSuggestions({ documentId: DOC_ID })).resolves.toEqual([]);
    expect(getSuggestionsByDocumentIdForUser).toHaveBeenCalledWith({
      documentId: DOC_ID,
      userId: ATTACKER_ID,
    });
  });
});
