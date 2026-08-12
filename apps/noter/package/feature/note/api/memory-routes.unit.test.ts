import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const authorizeMemoryRequest = vi.fn();
const rememberText = vi.fn();
const extractMemories = vi.fn();

vi.mock("./memory-request", async () => {
  const actual = await vi.importActual<typeof import("./memory-request")>(
    "./memory-request"
  );
  return {
    ...actual,
    authorizeMemoryRequest,
  };
});
vi.mock("@/feature/note/lib/pdw-client", () => ({
  rememberText,
  extractMemories,
}));
vi.mock("@/shared/lib/db", () => ({ db: {} }));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
}));
vi.mock("@/shared/lib/shared-redis", () => ({
  requireSharedRedisClient: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MEMWAL_PRIVATE_KEY = "server-wide-key-must-not-be-used";
  process.env.MEMWAL_ACCOUNT_ID = `0x${"1".repeat(64)}`;
});

describe("Noter memory routes", () => {
  it("never creates a client from process-wide credentials", async () => {
    const { getMemWalClient } = await vi.importActual<
      typeof import("@/feature/note/lib/pdw-client")
    >("@/feature/note/lib/pdw-client");

    expect(() => getMemWalClient()).toThrow("Session has no delegate key");
  });

  it.each([
    [
      "remember-one",
      () => import("../../../../app/api/memory/remember-one/route"),
    ],
    ["remember", () => import("../../../../app/api/memory/remember/route")],
  ])(
    "rejects unauthenticated %s requests before body or outbound work",
    async (_, load) => {
      const { MemoryRequestError } = await import("./memory-request");
      authorizeMemoryRequest.mockRejectedValueOnce(
        new MemoryRequestError(401, "Authentication required")
      );
      const { POST } = await load();
      const request = new Request("http://localhost/api/memory", {
        method: "POST",
        body: JSON.stringify({ text: "attacker-controlled memory content" }),
        headers: { "content-type": "application/json" },
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      expect(rememberText).not.toHaveBeenCalled();
      expect(extractMemories).not.toHaveBeenCalled();
      expect(request.bodyUsed).toBe(false);
    }
  );

  it("rejects tRPC analyze writes before note or outbound work", async () => {
    const { MemoryRequestError } = await import("./memory-request");
    authorizeMemoryRequest.mockRejectedValueOnce(
      new MemoryRequestError(401, "Session has no Walrus Memory credentials")
    );
    const findFirst = vi.fn();
    const { noteRouter } = await import("./route");
    const caller = noteRouter.createCaller({
      db: { query: { notes: { findFirst } } },
      request: new Request("http://localhost/api/trpc/note.detectMemories", {
        headers: { "x-session-id": "active-session" },
      }),
      userId: "user-1",
    } as never);

    await expect(
      caller.detectMemories({
        noteId: "00000000-0000-4000-8000-000000000001",
        plainText: "attacker-controlled memory content",
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(findFirst).not.toHaveBeenCalled();
    expect(extractMemories).not.toHaveBeenCalled();
  });

  it("applies the byte bound to database-backed tRPC analyze text", async () => {
    authorizeMemoryRequest.mockResolvedValueOnce({
      key: "session-bound-key",
      accountId: `0x${"2".repeat(64)}`,
    });
    const { MAX_MEMORY_TEXT_BYTES } = await import("./memory-policy");
    const findFirst = vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      userId: "user-1",
      plainText: "x".repeat(MAX_MEMORY_TEXT_BYTES + 1),
    });
    const { noteRouter } = await import("./route");
    const caller = noteRouter.createCaller({
      db: { query: { notes: { findFirst } } },
      request: new Request("http://localhost/api/trpc/note.detectMemories", {
        headers: { "x-session-id": "active-session" },
      }),
      userId: "user-1",
    } as never);

    await expect(
      caller.detectMemories({
        noteId: "00000000-0000-4000-8000-000000000001",
      })
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });

    expect(authorizeMemoryRequest).toHaveBeenCalledOnce();
    expect(extractMemories).not.toHaveBeenCalled();
  });

  it("does not reject valid near-limit text because of JSON framing", async () => {
    const { MAX_MEMORY_TEXT_BYTES, readMemoryText } =
      await import("./memory-request");
    const text = "x".repeat(MAX_MEMORY_TEXT_BYTES);
    const body = JSON.stringify({ text });
    const request = new Request("http://localhost/api/memory", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
    });

    await expect(readMemoryText(request)).resolves.toBe(text);
  });

  it("bounds memory text by encoded byte size", async () => {
    const { MAX_MEMORY_TEXT_BYTES, readMemoryText } =
      await import("./memory-request");
    const request = new Request("http://localhost/api/memory", {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(MAX_MEMORY_TEXT_BYTES + 1) }),
      headers: { "content-type": "application/json" },
    });

    await expect(readMemoryText(request)).rejects.toEqual(
      expect.objectContaining({ status: 413 })
    );
  });
});
