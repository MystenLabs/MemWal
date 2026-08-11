import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryNamespaceForUser } from "./memory-namespace";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  rememberAndWait: vi.fn(),
  withMemWal: vi.fn(),
}));

vi.mock("@mysten-incubation/memwal", () => ({
  MemWal: {
    create: mocks.create,
  },
}));

vi.mock("@mysten-incubation/memwal/ai", () => ({
  withMemWal: mocks.withMemWal,
}));

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const KEY = "a".repeat(64);
const ACCOUNT_ID = `0x${"b".repeat(64)}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReturnValue({ rememberAndWait: mocks.rememberAndWait });
  mocks.rememberAndWait.mockResolvedValue({});
  mocks.withMemWal.mockImplementation((_model, options) => ({ options }));
});

describe("chatbot memory namespace isolation", () => {
  it("derives stable, distinct namespaces and fails closed without a user id", () => {
    expect(memoryNamespaceForUser(USER_A)).toBe(`chatbot-user:${USER_A}`);
    expect(memoryNamespaceForUser(USER_B)).toBe(`chatbot-user:${USER_B}`);
    expect(memoryNamespaceForUser(USER_A)).not.toBe(memoryNamespaceForUser(USER_B));
    expect(memoryNamespaceForUser(undefined)).toBeNull();
    expect(memoryNamespaceForUser("   ")).toBeNull();
  });

  it("binds explicit memory saves to each authenticated user's namespace", async () => {
    const { saveMemory } = await import("./tools/save-memory");
    const namespaceA = memoryNamespaceForUser(USER_A)!;
    const namespaceB = memoryNamespaceForUser(USER_B)!;

    const toolA = saveMemory({
      namespace: namespaceA,
      memwalKey: KEY,
      memwalAccountId: ACCOUNT_ID,
    });
    const toolB = saveMemory({
      namespace: namespaceB,
      memwalKey: KEY,
      memwalAccountId: ACCOUNT_ID,
    });
    // @ts-expect-error — tool().execute is intentionally called at the unit-test boundary.
    await toolA.execute({ text: "User A private memory" });
    // @ts-expect-error — tool().execute is intentionally called at the unit-test boundary.
    await toolB.execute({ text: "User B private memory" });

    expect(mocks.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ namespace: namespaceA })
    );
    expect(mocks.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ namespace: namespaceB })
    );
  });

  it("binds automatic recall and auto-save middleware to the user namespace", async () => {
    const { getMemWalModel } = await import("./providers");
    const namespace = memoryNamespaceForUser(USER_A)!;

    getMemWalModel("openai/gpt-4o", {
      namespace,
      memwalKey: KEY,
      memwalAccountId: ACCOUNT_ID,
    });

    expect(mocks.withMemWal).toHaveBeenCalledOnce();
    expect(mocks.withMemWal.mock.calls[0][1]).toEqual(
      expect.objectContaining({ namespace })
    );
  });

  it("wires the authenticated session namespace into both chatbot memory paths", () => {
    const route = readFileSync(
      resolve("app/(chat)/api/chat/route.ts"),
      "utf8"
    );
    expect(route).toContain(
      "memoryNamespaceForUser(session.user.id)"
    );
    expect(route).toMatch(
      /getMemWalModel\(selectedChatModel, \{[\s\S]*?namespace: memoryNamespace/
    );
    expect(route).toMatch(
      /saveMemory\(\{[\s\S]*?namespace: memoryNamespace/
    );
  });

  it("refuses explicit saves when the authenticated namespace is missing", async () => {
    const { saveMemory } = await import("./tools/save-memory");
    const tool = saveMemory({
      namespace: "",
      memwalKey: KEY,
      memwalAccountId: ACCOUNT_ID,
    });
    // @ts-expect-error — tool().execute is intentionally called at the unit-test boundary.
    const result = await tool.execute({ text: "must not be stored" });

    expect(result).toMatchObject({ saved: false });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.rememberAndWait).not.toHaveBeenCalled();
  });
});
