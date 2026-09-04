import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the DB-layer owner scoping of
// getSuggestionsByDocumentIdForUser (WALM-438 / GH #786).
//
// The action-level suite mocks the query module, so it never executes the
// real SQL. This suite runs the REAL query body against a mocked drizzle
// builder, captures the WHERE clause, and asserts it filters on BOTH
// documentId AND userId. Dropping the userId predicate reopens the IDOR.

const DOC_VAL = "44444444-4444-4444-4444-444444444444";
const USER_VAL = "55555555-5555-5555-5555-555555555555";

let capturedWhere: unknown;

const where = vi.fn((clause: unknown) => {
  capturedWhere = clause;
  return Promise.resolve([]);
});
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));

vi.mock("server-only", () => ({}));
vi.mock("postgres", () => ({ default: () => ({}) }));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: () => ({ select }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  capturedWhere = undefined;
});

describe("getSuggestionsByDocumentIdForUser DB-layer scoping", () => {
  it("filters on both documentId and the owner userId", async () => {
    const { getSuggestionsByDocumentIdForUser } = await import("./queries");

    await getSuggestionsByDocumentIdForUser({
      documentId: DOC_VAL,
      userId: USER_VAL,
    });

    expect(where).toHaveBeenCalledTimes(1);
    expect(capturedWhere).toBeDefined();

    const { sql, params } = new PgDialect().sqlToQuery(capturedWhere as never);

    expect(sql).toMatch(/"documentId"/);
    expect(sql).toMatch(/"userId"/);
    expect(params).toContain(DOC_VAL);
    expect(params).toContain(USER_VAL);
  });
});
