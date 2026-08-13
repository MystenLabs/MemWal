import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-layer guard tests for the delegate-key export path. These exercise the
// REAL authRouter procedures via createCaller, asserting the route enforces:
//   - protectedProcedure: no session -> UNAUTHORIZED
//   - session/address binding: session address A requesting address B -> FORBIDDEN
//   - the happy path returns the key only when session address == requested and
//     the export-purpose challenge verifies.
// The service + challenge layers are mocked so no DB/Redis/crypto is needed; the
// logic under test is the route's own gating.

vi.mock("server-only", () => ({}));

const ADDR_A = `0x${"a".repeat(64)}`;
const ADDR_B = `0x${"b".repeat(64)}`;

// Service mock: user "userA" resolves to ADDR_A; delegate key exists for ADDR_A.
const getUserAddressById = vi.fn(async (_db: unknown, userId: string) =>
  userId === "userA" ? ADDR_A : null
);
const getDelegateKeyForOwner = vi.fn(async (_db: unknown, addr: string) =>
  addr === ADDR_A
    ? { delegatePrivateKey: "secret-A", delegateAccountId: "acct-A" }
    : null
);

vi.mock("../domain/service", () => ({
  getUserAddressById,
  getDelegateKeyForOwner,
  toSafeUser: (u: unknown) => u,
  DelegateCredentialConflictError: class extends Error {},
}));

// Challenge verifies true for an export-purpose call; issuance returns a stub.
const verifyAndConsumeEnokiChallenge = vi.fn(async () => true);
vi.mock("../lib/enoki-challenge", () => ({
  issueEnokiChallenge: vi.fn(async () => ({ challengeId: "c1", message: "m" })),
  verifyAndConsumeEnokiChallenge,
}));

vi.mock("@/shared/lib/shared-redis", () => ({
  SharedRedisUnavailableError: class extends Error {},
}));

async function callerFor(userId: string | null) {
  const { authRouter } = await import("./route");
  // Minimal ctx matching the tRPC Context shape used by these procedures.
  const ctx = {
    db: {},
    request: new Request("http://localhost/api/trpc/auth"),
    userId,
  };
  return authRouter.createCaller(ctx as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exportDelegateKey — route-layer guards", () => {
  it("rejects an unauthenticated caller (no session) with UNAUTHORIZED", async () => {
    const caller = await callerFor(null);
    await expect(
      caller.exportDelegateKey({
        suiAddress: ADDR_A,
        challengeId: "c1",
        signature: "sig",
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Must never reach the key lookup.
    expect(getDelegateKeyForOwner).not.toHaveBeenCalled();
  });

  it("rejects a mismatched session (session A requesting address B) with FORBIDDEN", async () => {
    const caller = await callerFor("userA"); // session resolves to ADDR_A
    await expect(
      caller.exportDelegateKey({
        suiAddress: ADDR_B, // asking for someone else's key
        challengeId: "c1",
        signature: "sig",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getDelegateKeyForOwner).not.toHaveBeenCalled();
  });

  it("returns the key when the session address matches the requested address", async () => {
    const caller = await callerFor("userA");
    const result = await caller.exportDelegateKey({
      suiAddress: ADDR_A,
      challengeId: "c1",
      signature: "sig",
    });
    expect(result).toEqual({
      delegatePrivateKey: "secret-A",
      delegateAccountId: "acct-A",
    });
  });
});

describe("issueExportChallenge — own-address only", () => {
  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = await callerFor(null);
    await expect(caller.issueExportChallenge()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
