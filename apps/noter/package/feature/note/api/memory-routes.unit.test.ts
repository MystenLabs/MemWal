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
vi.mock("@/shared/db/schema", () => ({ users: {}, walletSessions: {} }));
vi.mock("@/shared/lib/shared-redis", () => ({
  requireSharedRedisClient: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MEMWAL_PRIVATE_KEY = "server-wide-key-must-not-be-used";
  process.env.MEMWAL_ACCOUNT_ID = `0x${"1".repeat(64)}`;
});

describe("Noter memory routes", () => {
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
