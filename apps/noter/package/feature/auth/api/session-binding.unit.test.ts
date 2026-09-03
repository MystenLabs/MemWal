import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-layer binding tests for getSession / logout (issue #779). Both used to
// take a sessionId as procedure input and act on it, so anyone who learned an id
// could read that session's user and address or delete the session, without ever
// presenting the id as a credential. Both now read the id from ctx.sessionId,
// which createContext fills from the x-session-id header.
//
// These call the REAL authRouter through createCaller and pass a victim id as
// input anyway, cast past the types, to prove the input cannot steer either
// procedure. The service layer is mocked so no DB is needed.

vi.mock("server-only", () => ({}));

const CALLER_SESSION = "0192f0a0-0000-7000-8000-000000000001";
const VICTIM_SESSION = "0192f0a0-0000-7000-8000-000000000002";

const VICTIM_SESSION_ROW = {
  user: { id: "victim", suiAddress: `0x${"b".repeat(64)}` },
  sessionId: VICTIM_SESSION,
  suiAddress: `0x${"b".repeat(64)}`,
  expiresAt: new Date(Date.now() + 60_000),
};

const CALLER_SESSION_ROW = {
  user: { id: "caller", suiAddress: `0x${"a".repeat(64)}` },
  sessionId: CALLER_SESSION,
  suiAddress: `0x${"a".repeat(64)}`,
  expiresAt: new Date(Date.now() + 60_000),
};

const getActiveSession = vi.fn(async (_db: unknown, sessionId: string) => {
  if (sessionId === CALLER_SESSION) return CALLER_SESSION_ROW;
  if (sessionId === VICTIM_SESSION) return VICTIM_SESSION_ROW;
  return null;
});
const deleteSession = vi.fn(async () => undefined);

vi.mock("../domain/service", () => ({
  getActiveSession,
  deleteSession,
  toSafeUser: (u: unknown) => u,
  DelegateCredentialConflictError: class extends Error {},
}));

vi.mock("../lib/enoki-challenge", () => ({
  issueEnokiChallenge: vi.fn(),
  verifyAndConsumeEnokiChallenge: vi.fn(),
}));

vi.mock("@/shared/lib/shared-redis", () => ({
  SharedRedisUnavailableError: class extends Error {},
}));

// sessionId mirrors what createContext read from x-session-id; null means the
// caller presented no usable session header.
async function callerFor(sessionId: string | null) {
  const { authRouter } = await import("./route");
  const ctx = {
    db: {},
    request: new Request("http://localhost/api/trpc/auth"),
    sessionId,
    userId: sessionId === CALLER_SESSION ? "caller" : null,
  };
  return authRouter.createCaller(ctx as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSession — bound to the caller's own session", () => {
  it("returns null when the caller presents no session header", async () => {
    const caller = await callerFor(null);

    await expect(caller.getSession()).resolves.toBeNull();
    expect(getActiveSession).not.toHaveBeenCalled();
  });

  it("ignores a victim session id passed as input", async () => {
    const caller = await callerFor(null);

    // The exact request from the report: a valid id, no credential for it.
    const result = await (
      caller.getSession as unknown as (input: unknown) => Promise<unknown>
    )({ sessionId: VICTIM_SESSION });

    expect(result).toBeNull();
    expect(getActiveSession).not.toHaveBeenCalledWith(
      expect.anything(),
      VICTIM_SESSION
    );
  });

  it("reads the header session even when the input names another one", async () => {
    const caller = await callerFor(CALLER_SESSION);

    const result = await (
      caller.getSession as unknown as (input: unknown) => Promise<unknown>
    )({ sessionId: VICTIM_SESSION });

    expect(result).toEqual(CALLER_SESSION_ROW);
    expect(getActiveSession).toHaveBeenCalledWith(
      expect.anything(),
      CALLER_SESSION
    );
  });

  it("returns null for a header session that no longer resolves", async () => {
    const caller = await callerFor("0192f0a0-0000-7000-8000-00000000dead");

    await expect(caller.getSession()).resolves.toBeNull();
  });
});

describe("logout — ends only the caller's own session", () => {
  it("deletes nothing when the caller presents no session header", async () => {
    const caller = await callerFor(null);

    await expect(caller.logout()).resolves.toEqual({ success: true });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("ignores a victim session id passed as input", async () => {
    const caller = await callerFor(null);

    await (
      caller.logout as unknown as (input: unknown) => Promise<unknown>
    )({ sessionId: VICTIM_SESSION });

    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("deletes the header session even when the input names another one", async () => {
    const caller = await callerFor(CALLER_SESSION);

    await (
      caller.logout as unknown as (input: unknown) => Promise<unknown>
    )({ sessionId: VICTIM_SESSION });

    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith(
      expect.anything(),
      CALLER_SESSION
    );
  });
});
