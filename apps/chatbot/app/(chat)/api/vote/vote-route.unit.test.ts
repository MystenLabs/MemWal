import { beforeEach, describe, expect, it, vi } from "vitest";

// A vote row references Message_v2.id with no cascade. A vote from chat B on
// a message in chat A would block A's owner from deleting chat A, so PATCH
// only accepts a message that belongs to the caller's chat.

const state = vi.hoisted(() => {
  const USER_B = "22222222-2222-4222-8222-222222222222";
  const CHAT_A = "33333333-3333-4333-8333-333333333333";
  const CHAT_B = "44444444-4444-4444-8444-444444444444";
  const MESSAGE_A = "55555555-5555-4555-8555-555555555555";
  const MESSAGE_B = "66666666-6666-4666-8666-666666666666";
  const MISSING = "77777777-7777-4777-8777-777777777777";

  const messages = new Map([
    [MESSAGE_A, { id: MESSAGE_A, chatId: CHAT_A }],
    [MESSAGE_B, { id: MESSAGE_B, chatId: CHAT_B }],
  ]);

  return {
    USER_B,
    CHAT_A,
    CHAT_B,
    MESSAGE_A,
    MESSAGE_B,
    MISSING,
    auth: vi.fn(async () => ({
      user: { id: USER_B, type: "regular" as const, email: "b@example.com" },
      expires: "",
    })),
    getChatById: vi.fn(async ({ id }: { id: string }) =>
      id === CHAT_B ? { id: CHAT_B, userId: USER_B } : null
    ),
    getMessageById: vi.fn(async ({ id }: { id: string }) => {
      const row = messages.get(id);
      return row ? [row] : [];
    }),
    voteMessage: vi.fn(async () => undefined),
  };
});

vi.mock("@/app/(auth)/auth", () => ({ auth: state.auth }));
vi.mock("@/lib/db/queries", () => ({
  getChatById: state.getChatById,
  getMessageById: state.getMessageById,
  getVotesByChatId: vi.fn(async () => []),
  voteMessage: state.voteMessage,
}));

function patch(body: Record<string, unknown>) {
  return new Request("http://localhost/api/vote", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/vote message scoping", () => {
  it("rejects a vote on another chat's message without writing", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      patch({ chatId: state.CHAT_B, messageId: state.MESSAGE_A, type: "up" })
    );

    expect(response.status).toBe(404);
    expect(state.voteMessage).not.toHaveBeenCalled();
  });

  it("rejects a vote on a message that does not exist", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      patch({ chatId: state.CHAT_B, messageId: state.MISSING, type: "down" })
    );

    expect(response.status).toBe(404);
    expect(state.voteMessage).not.toHaveBeenCalled();
  });

  it("still records a vote on a message in the caller's chat", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(
      patch({ chatId: state.CHAT_B, messageId: state.MESSAGE_B, type: "up" })
    );

    expect(response.status).toBe(200);
    expect(state.voteMessage).toHaveBeenCalledWith({
      chatId: state.CHAT_B,
      messageId: state.MESSAGE_B,
      type: "up",
    });
  });
});
