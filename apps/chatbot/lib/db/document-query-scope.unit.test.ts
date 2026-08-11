import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the *DB-layer* owner scoping of getDocumentByIdForUser.
//
// The ownership test suite (lib/ai/tools/document-ownership.unit.test.ts) mocks
// the whole query module, so it proves the tools' call-site re-check but never
// executes the real SQL. This suite closes that gap: it runs the REAL
// getDocumentByIdForUser body against a mocked drizzle query builder, captures
// the WHERE clause it hands to the DB, renders it to SQL, and asserts the query
// filters on BOTH the document id AND the owner's userId.
//
// If someone drops the `eq(document.userId, userId)` predicate to reopen the
// original IDOR at the DB layer, the rendered SQL loses the userId filter and
// this test fails.

const ID_VAL = "44444444-4444-4444-4444-444444444444";
const USER_VAL = "55555555-5555-5555-5555-555555555555";

// Capture the SQL object passed to .where() so we can render it below.
let capturedWhere: unknown;

const orderBy = vi.fn(async () => [] as unknown[]);
const where = vi.fn((clause: unknown) => {
  capturedWhere = clause;
  return { orderBy };
});
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));

// queries.ts is a server module (`import "server-only"`); stub the guard so it
// can be imported into the vitest (node) environment.
vi.mock("server-only", () => ({}));

// Mock the postgres client + drizzle so importing queries.ts neither opens a
// real connection nor needs POSTGRES_URL — while leaving the query BODY intact.
vi.mock("postgres", () => ({ default: () => ({}) }));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: () => ({ select }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  capturedWhere = undefined;
});

describe("getDocumentByIdForUser DB-layer scoping", () => {
  it("filters on both the document id and the owner userId", async () => {
    const { getDocumentByIdForUser } = await import("./queries");

    await getDocumentByIdForUser({ id: ID_VAL, userId: USER_VAL });

    expect(where).toHaveBeenCalledTimes(1);
    expect(capturedWhere).toBeDefined();

    // Render the captured WHERE clause to concrete SQL + bound params.
    const { sql, params } = new PgDialect().sqlToQuery(capturedWhere as never);

    // The query must reference BOTH columns...
    expect(sql).toMatch(/"id"/);
    expect(sql).toMatch(/"userId"/);
    // ...and bind BOTH values — losing the userId predicate (the IDOR) would
    // drop USER_VAL from the params.
    expect(params).toContain(ID_VAL);
    expect(params).toContain(USER_VAL);
  });
});
