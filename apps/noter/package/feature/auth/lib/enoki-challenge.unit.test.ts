import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests the ownership-challenge security properties:
//   - purpose scoping: a sign-in challenge cannot satisfy an export verify (and
//     vice versa), so a signature obtained under "sign in" can't be replayed to
//     authorize a delegate-key export.
//   - single-use / replay: the challenge is consumed with GETDEL, so a second
//     verify of the same challenge fails.
//   - address binding: the recovered signer must match the claimed address.
// Redis and the signature verifier are mocked so no real infra is needed.

const ADDR = `0x${"1".repeat(64)}`;
const OTHER = `0x${"2".repeat(64)}`;

// In-memory stand-in for the Redis single-use store.
const store = new Map<string, string>();
const redis = {
  set: vi.fn(async (key: string, val: string, _opts: unknown) => {
    if (store.has(key)) return null; // NX
    store.set(key, val);
    return "OK";
  }),
  getDel: vi.fn(async (key: string) => {
    const v = store.get(key) ?? null;
    store.delete(key); // atomic consume
    return v;
  }),
};

// enoki-challenge.ts is a server module (`import "server-only"`); stub the guard
// so it can be imported into the vitest (node) environment.
vi.mock("server-only", () => ({}));

vi.mock("@/shared/lib/shared-redis", () => ({
  requireSharedRedisClient: vi.fn(async () => redis),
  SharedRedisUnavailableError: class extends Error {},
}));

// Signature verifier: returns a public key whose toSuiAddress() is whatever the
// test set via setRecoveredAddress(). Lets us simulate a valid signature.
let recoveredAddress = ADDR;
vi.mock("@mysten/sui/verify", () => ({
  verifyPersonalMessageSignature: vi.fn(async () => ({
    toSuiAddress: () => recoveredAddress,
  })),
}));

vi.mock("@mysten/sui/graphql", () => ({ SuiGraphQLClient: class {} }));

async function load() {
  return await import("./enoki-challenge");
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  recoveredAddress = ADDR;
});

describe("enoki challenge — purpose scoping", () => {
  it("accepts a signin signature for a signin verify", async () => {
    const { issueEnokiChallenge, verifyAndConsumeEnokiChallenge } = await load();
    const { challengeId } = await issueEnokiChallenge(ADDR, "signin");
    const ok = await verifyAndConsumeEnokiChallenge({
      rawAddress: ADDR,
      challengeId,
      signature: "sig",
      purpose: "signin",
    });
    expect(ok).toBe(true);
  });

  it("rejects a signin challenge used for an export verify (no cross-purpose replay)", async () => {
    const { issueEnokiChallenge, verifyAndConsumeEnokiChallenge } = await load();
    const { challengeId } = await issueEnokiChallenge(ADDR, "signin");
    const ok = await verifyAndConsumeEnokiChallenge({
      rawAddress: ADDR,
      challengeId,
      signature: "sig",
      purpose: "export",
    });
    expect(ok).toBe(false);
  });

  it("rejects an export challenge used for a signin verify", async () => {
    const { issueEnokiChallenge, verifyAndConsumeEnokiChallenge } = await load();
    const { challengeId } = await issueEnokiChallenge(ADDR, "export");
    const ok = await verifyAndConsumeEnokiChallenge({
      rawAddress: ADDR,
      challengeId,
      signature: "sig",
      purpose: "signin",
    });
    expect(ok).toBe(false);
  });
});

describe("enoki challenge — replay + binding", () => {
  it("is single-use: the same challenge cannot be verified twice", async () => {
    const { issueEnokiChallenge, verifyAndConsumeEnokiChallenge } = await load();
    const { challengeId } = await issueEnokiChallenge(ADDR, "signin");
    const first = await verifyAndConsumeEnokiChallenge({
      rawAddress: ADDR,
      challengeId,
      signature: "sig",
      purpose: "signin",
    });
    const second = await verifyAndConsumeEnokiChallenge({
      rawAddress: ADDR,
      challengeId,
      signature: "sig",
      purpose: "signin",
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("rejects when the recovered signer does not match the claimed address", async () => {
    const { issueEnokiChallenge, verifyAndConsumeEnokiChallenge } = await load();
    const { challengeId } = await issueEnokiChallenge(ADDR, "signin");
    recoveredAddress = OTHER; // signature verifies to a different address
    const ok = await verifyAndConsumeEnokiChallenge({
      rawAddress: ADDR,
      challengeId,
      signature: "sig",
      purpose: "signin",
    });
    expect(ok).toBe(false);
  });

  it("rejects a challenge issued for a different address", async () => {
    const { issueEnokiChallenge, verifyAndConsumeEnokiChallenge } = await load();
    const { challengeId } = await issueEnokiChallenge(ADDR, "signin");
    const ok = await verifyAndConsumeEnokiChallenge({
      rawAddress: OTHER,
      challengeId,
      signature: "sig",
      purpose: "signin",
    });
    expect(ok).toBe(false);
  });

  it("rejects an unknown / already-expired challengeId", async () => {
    const { verifyAndConsumeEnokiChallenge } = await load();
    const ok = await verifyAndConsumeEnokiChallenge({
      rawAddress: ADDR,
      challengeId: "does-not-exist",
      signature: "sig",
      purpose: "signin",
    });
    expect(ok).toBe(false);
  });
});
