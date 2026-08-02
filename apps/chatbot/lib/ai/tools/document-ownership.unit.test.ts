import type { Session } from "next-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the document-tool IDOR (GH #516 / WALM-309): the
// updateDocument and requestSuggestions tools must not read or mutate a
// document that belongs to another user. We mock the DB query layer so no real
// Postgres connection is needed.
//
// The fix has TWO layers and this suite proves BOTH:
//   1. The owner-scoped DB lookup (getDocumentByIdForUser) — simulated by the
//      default mock, which returns the doc only when id AND userId match.
//   2. The call-site re-check (`document.userId !== session.user?.id`) in each
//      tool — proven by the "call-site check" tests below, which make the mock
//      return the victim doc EVEN FOR AN ATTACKER (as if the DB layer were
//      compromised/refactored to drop its owner filter). If the call-site check
//      were removed, those tests fail. (This layer was silently stripped once
//      during development and the old test did not catch it — hence these.)

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const ATTACKER_ID = "22222222-2222-2222-2222-222222222222";
const DOC_ID = "33333333-3333-3333-3333-333333333333";

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    userId: OWNER_ID,
    title: "Victim private doc",
    content: "CONFIDENTIAL",
    kind: "text" as const,
    createdAt: new Date(),
    ...overrides,
  };
}

// Default mock = a faithful owner-scoped lookup: returns the row only when the
// requested id AND userId match (mirrors the real SQL `where(id AND userId)`).
const getDocumentByIdForUser = vi.fn(
  async ({ id, userId }: { id: string; userId: string }) =>
    id === DOC_ID && userId === OWNER_ID ? makeDoc() : undefined
);
const saveSuggestions = vi.fn(async () => undefined);

// Mock the whole query module so importing the tools never initializes the
// top-level postgres() client in lib/db/queries.ts.
vi.mock("@/lib/db/queries", () => ({
  getDocumentByIdForUser,
  saveSuggestions,
}));

// updateDocument reaches into the artifact handlers to perform the write; stub
// them so we can observe whether the write path was reached at all.
const onUpdateDocument = vi.fn(async () => undefined);
vi.mock("@/lib/artifacts/server", () => ({
  documentHandlersByArtifactKind: [{ kind: "text", onUpdateDocument }],
}));

vi.mock("../providers", () => ({ getArtifactModel: () => ({}) }));

function sessionFor(userId: string): Session {
  return { user: { id: userId }, expires: "" } as unknown as Session;
}

const noopDataStream = { write: vi.fn() } as any;

async function runUpdate(callerId: string) {
  const { updateDocument } = await import("./update-document");
  const t = updateDocument({
    session: sessionFor(callerId),
    dataStream: noopDataStream,
  });
  // @ts-expect-error — tool().execute signature is loose at the test boundary
  return t.execute({ id: DOC_ID, description: "make a change" });
}

async function runSuggestions(callerId: string) {
  const { requestSuggestions } = await import("./request-suggestions");
  const t = requestSuggestions({
    session: sessionFor(callerId),
    dataStream: noopDataStream,
  });
  // @ts-expect-error — tool().execute signature is loose at the test boundary
  return t.execute({ documentId: DOC_ID });
}

// Force the mock to return the victim doc regardless of the userId argument —
// i.e. simulate the DB-layer owner filter being absent. The tool's OWN call-site
// check is then the only thing standing between an attacker and the document.
function pretendLookupIgnoresOwner(doc = makeDoc()) {
  getDocumentByIdForUser.mockResolvedValue(doc);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore the default owner-scoped behavior after any per-test override.
  getDocumentByIdForUser.mockImplementation(
    async ({ id, userId }: { id: string; userId: string }) =>
      id === DOC_ID && userId === OWNER_ID ? makeDoc() : undefined
  );
});

describe("updateDocument ownership (WALM-309)", () => {
  it("DB-layer scoping: rejects a cross-owner document without writing", async () => {
    const result = await runUpdate(ATTACKER_ID);
    expect(result).toEqual({ error: "Document not found" });
    expect(onUpdateDocument).not.toHaveBeenCalled();
  });

  it("call-site check: rejects even if the lookup returns a cross-owner doc", async () => {
    // Lookup layer compromised: returns the victim's doc to the attacker.
    pretendLookupIgnoresOwner();
    const result = await runUpdate(ATTACKER_ID);
    // The tool's own userId re-check must still reject and never write.
    expect(result).toEqual({ error: "Document not found" });
    expect(onUpdateDocument).not.toHaveBeenCalled();
  });

  it("allows the owner to update their own document", async () => {
    const result = await runUpdate(OWNER_ID);
    expect(result).toMatchObject({ id: DOC_ID, kind: "text" });
    expect(result).not.toHaveProperty("error");
    expect(onUpdateDocument).toHaveBeenCalledTimes(1);
  });
});

describe("requestSuggestions ownership (WALM-309)", () => {
  it("DB-layer scoping: rejects reading a cross-owner document", async () => {
    const result = await runSuggestions(ATTACKER_ID);
    expect(result).toEqual({ error: "Document not found" });
    expect(saveSuggestions).not.toHaveBeenCalled();
  });

  it("call-site check: rejects even if the lookup returns a cross-owner doc", async () => {
    pretendLookupIgnoresOwner();
    const result = await runSuggestions(ATTACKER_ID);
    expect(result).toEqual({ error: "Document not found" });
    expect(saveSuggestions).not.toHaveBeenCalled();
  });

  it("owner with empty content: returns not found (no content to suggest on)", async () => {
    // Owner's own doc but content-less — same "not found" as before the fix.
    getDocumentByIdForUser.mockResolvedValue(makeDoc({ content: "" }));
    const result = await runSuggestions(OWNER_ID);
    expect(result).toEqual({ error: "Document not found" });
  });

  it("lets the owner past the ownership gate (reaches the suggestion path)", async () => {
    // The owner's own doc must pass the ownership + content gate. Downstream the
    // tool calls streamText() with the real artifact model, which isn't wired in
    // a unit test — so "passed the gate" is proven by the call reaching that LLM
    // step (an AI-SDK model error) rather than short-circuiting with the
    // ownership "Document not found" return.
    await expect(runSuggestions(OWNER_ID)).rejects.toThrow(
      /model version|Unsupported model/i
    );
    // If the ownership check had wrongly rejected the owner, execute() would
    // have resolved to { error: "Document not found" } and never thrown here.
  });
});
