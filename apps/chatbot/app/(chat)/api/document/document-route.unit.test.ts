import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for WALM-422: DELETE /api/document read `.userId` off the
// first row without checking that a row came back, so an id matching no
// document threw TypeError and the request 500s with an empty body. The GET
// handler in the same file already had the guard, so the two disagreed on the
// same missing document.
//
// The DB query layer is mocked so no Postgres connection is needed.

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
const DOC_ID = "33333333-3333-3333-3333-333333333333";
const MISSING_ID = "44444444-4444-4444-4444-444444444444";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function makeDoc(userId = OWNER_ID) {
  return {
    id: DOC_ID,
    userId,
    title: "A document",
    content: "body",
    kind: "text" as const,
    createdAt: new Date(),
  };
}

const getDocumentsById = vi.fn(async ({ id }: { id: string }) =>
  id === DOC_ID ? [makeDoc()] : []
);
const deleteDocumentsByIdAfterTimestamp = vi.fn(async () => [makeDoc()]);
const saveDocument = vi.fn(async () => makeDoc());

vi.mock("@/lib/db/queries", () => ({
  getDocumentsById,
  deleteDocumentsByIdAfterTimestamp,
  saveDocument,
}));

const auth = vi.fn(async () => ({ user: { id: OWNER_ID }, expires: "" }));
vi.mock("@/app/(auth)/auth", () => ({ auth }));

function deleteRequest(id: string, timestamp = TIMESTAMP) {
  return new Request(
    `http://localhost/api/document?id=${id}&timestamp=${timestamp}`,
    { method: "DELETE" }
  );
}

async function callDelete(id: string) {
  const { DELETE } = await import("./route");
  return DELETE(deleteRequest(id));
}

beforeEach(() => {
  vi.clearAllMocks();
  getDocumentsById.mockImplementation(async ({ id }: { id: string }) =>
    id === DOC_ID ? [makeDoc()] : []
  );
  auth.mockResolvedValue({ user: { id: OWNER_ID }, expires: "" });
});

describe("DELETE /api/document", () => {
  it("returns 404 for an id that matches no document", async () => {
    const response = await callDelete(MISSING_ID);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "not_found:document",
    });
    // Nothing may be deleted on the way to reporting the miss.
    expect(deleteDocumentsByIdAfterTimestamp).not.toHaveBeenCalled();
  });

  it("agrees with GET on the same missing document", async () => {
    const { GET } = await import("./route");
    const getResponse = await GET(
      new Request(`http://localhost/api/document?id=${MISSING_ID}`)
    );
    const deleteResponse = await callDelete(MISSING_ID);

    expect(deleteResponse.status).toBe(getResponse.status);
  });

  it("returns 403 for a document owned by someone else", async () => {
    getDocumentsById.mockResolvedValue([makeDoc(OTHER_ID)]);

    const response = await callDelete(DOC_ID);

    expect(response.status).toBe(403);
    expect(deleteDocumentsByIdAfterTimestamp).not.toHaveBeenCalled();
  });

  it("deletes the caller's own document", async () => {
    const response = await callDelete(DOC_ID);

    expect(response.status).toBe(200);
    expect(deleteDocumentsByIdAfterTimestamp).toHaveBeenCalledWith({
      id: DOC_ID,
      timestamp: new Date(TIMESTAMP),
    });
  });

  it("rejects a missing timestamp before reaching the database", async () => {
    const { DELETE } = await import("./route");
    const response = await DELETE(
      new Request(`http://localhost/api/document?id=${DOC_ID}`, {
        method: "DELETE",
      })
    );

    expect(response.status).toBe(400);
    expect(getDocumentsById).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before reaching the database", async () => {
    auth.mockResolvedValue(null as never);

    const response = await callDelete(DOC_ID);

    expect(response.status).toBe(401);
    expect(getDocumentsById).not.toHaveBeenCalled();
  });
});
