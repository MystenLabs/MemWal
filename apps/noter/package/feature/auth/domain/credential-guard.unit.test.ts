import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests the insert-only credential guard in upsertEnokiUser: once a user row has
// a delegate private key, the connect/register path must not overwrite it with
// caller-supplied values (that would let a caller replace an existing owner's
// stored signing key). A minimal drizzle-shaped mock stands in for the DB.

// service.ts pulls in server-only modules transitively; stub the guard so it can
// be imported into the vitest (node) environment.
vi.mock("server-only", () => ({}));

const ADDR = `0x${"3".repeat(64)}`;

let existingRow: Record<string, unknown> | undefined;
const updateSet = vi.fn();
const insertValues = vi.fn();

// Minimal chainable drizzle mock: select().from().where().limit() resolves to
// [existingRow] (or []); update()/insert() record their payloads.
function makeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (existingRow ? [existingRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: (payload: unknown) => {
        updateSet(payload);
        return {
          where: () => ({ returning: async () => [{ id: "u1", ...(payload as object) }] }),
        };
      },
    }),
    insert: () => ({
      values: (payload: unknown) => {
        insertValues(payload);
        return { returning: async () => [{ id: "u-new", ...(payload as object) }] };
      },
    }),
  };
}

async function load() {
  return await import("./service");
}

beforeEach(() => {
  vi.clearAllMocks();
  existingRow = undefined;
});

describe("upsertEnokiUser — insert-only credential guard", () => {
  it("inserts a new user when no row exists", async () => {
    const { upsertEnokiUser } = await load();
    const db = makeDb();
    await upsertEnokiUser(db as never, {
      suiAddress: ADDR,
      delegatePrivateKey: "key-new",
      delegateAccountId: "acct-new",
    });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("provisions creds on an existing row that has none yet", async () => {
    existingRow = { id: "u1", authMethod: "enoki", delegatePrivateKey: null };
    const { upsertEnokiUser } = await load();
    const db = makeDb();
    await upsertEnokiUser(db as never, {
      suiAddress: ADDR,
      delegatePrivateKey: "key-first",
      delegateAccountId: "acct-first",
    });
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing row that already has a delegate key", async () => {
    existingRow = {
      id: "u1",
      authMethod: "enoki",
      delegatePrivateKey: "existing-secret",
      delegateAccountId: "existing-acct",
    };
    const { upsertEnokiUser, DelegateCredentialConflictError } = await load();
    const db = makeDb();
    await expect(
      upsertEnokiUser(db as never, {
        suiAddress: ADDR,
        delegatePrivateKey: "attacker-key",
        delegateAccountId: "attacker-acct",
      })
    ).rejects.toBeInstanceOf(DelegateCredentialConflictError);
    // The stored key must never be replaced.
    expect(updateSet).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});
