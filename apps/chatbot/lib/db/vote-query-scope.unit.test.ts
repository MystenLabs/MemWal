import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CHAT_VAL = "66666666-6666-6666-6666-666666666666";
const MESSAGE_VAL = "77777777-7777-7777-7777-777777777777";

let capturedWhere: unknown;

const where = vi.fn((clause: unknown) => {
  capturedWhere = clause;
  return Promise.resolve([]);
});
const from = vi.fn(() => ({ where }));
const select = vi.fn(() => ({ from }));
const values = vi.fn(() => Promise.resolve([]));
const insert = vi.fn(() => ({ values }));

vi.mock("server-only", () => ({}));
vi.mock("postgres", () => ({ default: () => ({}) }));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: () => ({ select, insert }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  capturedWhere = undefined;
});

describe("voteMessage DB-layer scoping", () => {
  it("scopes the existing-vote lookup to both chatId and messageId", async () => {
    const { voteMessage } = await import("./queries");

    await voteMessage({
      chatId: CHAT_VAL,
      messageId: MESSAGE_VAL,
      type: "up",
    });

    expect(where).toHaveBeenCalledTimes(1);
    expect(capturedWhere).toBeDefined();

    const { sql, params } = new PgDialect().sqlToQuery(capturedWhere as never);

    expect(sql).toMatch(/"chatId"/);
    expect(sql).toMatch(/"messageId"/);
    expect(params).toContain(CHAT_VAL);
    expect(params).toContain(MESSAGE_VAL);
  });
});
