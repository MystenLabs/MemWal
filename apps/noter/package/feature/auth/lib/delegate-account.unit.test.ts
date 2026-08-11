import { fromHex, toBase64 } from "@mysten/sui/utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@mysten/sui/grpc", () => ({ SuiGrpcClient: class {} }));

const PACKAGE = `0x${"1".repeat(64)}`;
const OWNER = `0x${"2".repeat(64)}`;
const KEY = "ab".repeat(32);

async function validate(
  fields: Record<string, unknown>,
  type = `${PACKAGE}::account::MemWalAccount`
) {
  const { delegateAccountBindingError } = await import("./delegate-account");
  return delegateAccountBindingError(type, fields, {
    owner: OWNER,
    publicKeyHex: KEY,
    packageId: PACKAGE,
  });
}

describe("delegate account binding", () => {
  it("accepts the authenticated owner and registered delegate key", async () => {
    await expect(
      validate({
        active: true,
        owner: OWNER,
        delegate_keys: [{ public_key: toBase64(fromHex(KEY)) }],
      })
    ).resolves.toBeNull();
  });

  it("rejects owner, package, and delegate-key mismatches", async () => {
    const fields = {
      active: true,
      owner: `0x${"3".repeat(64)}`,
      delegate_keys: [{ public_key: Array.from(fromHex("cd".repeat(32))) }],
    };

    await expect(validate(fields)).resolves.toMatch(/owner/);
    await expect(validate({ ...fields, owner: OWNER })).resolves.toMatch(
      /not registered/
    );
    await expect(
      validate(
        {
          ...fields,
          owner: OWNER,
          delegate_keys: [{ public_key: Array.from(fromHex(KEY)) }],
        },
        `0x${"4".repeat(64)}::account::MemWalAccount`
      )
    ).resolves.toMatch(/configured MemWalAccount/);
  });

  it("rejects inactive accounts", async () => {
    await expect(
      validate({
        active: false,
        owner: OWNER,
        delegate_keys: [{ public_key: Array.from(fromHex(KEY)) }],
      })
    ).resolves.toMatch(/inactive/);
  });
});
