import { describe, expect, it } from "vitest";
import {
  AccountCreatedBcs,
  AccountRegistryBcs,
  MemWalAccountBcs,
} from "./account-bcs";

const ID = `0x${"11".repeat(32)}`;
const OWNER = `0x${"22".repeat(32)}`;
const TABLE = `0x${"33".repeat(32)}`;

describe("account BCS schemas", () => {
  it("round-trips a MemWalAccount", () => {
    const value = {
      id: ID,
      owner: OWNER,
      delegate_keys: [],
      created_at: BigInt(1),
      active: true,
    };
    const parsed = MemWalAccountBcs.parse(MemWalAccountBcs.serialize(value).toBytes());
    expect(parsed.id).toBe(ID);
    expect(parsed.owner).toBe(OWNER);
    expect(parsed.active).toBe(true);
    expect(parsed.delegate_keys).toEqual([]);
  });

  it("round-trips an AccountCreated event", () => {
    const parsed = AccountCreatedBcs.parse(
      AccountCreatedBcs.serialize({ account_id: ID, owner: OWNER }).toBytes()
    );
    expect(parsed.account_id).toBe(ID);
    expect(parsed.owner).toBe(OWNER);
  });

  it("round-trips an AccountRegistry", () => {
    const parsed = AccountRegistryBcs.parse(
      AccountRegistryBcs.serialize({
        id: ID,
        accounts: { id: TABLE, size: BigInt(1) },
      }).toBytes()
    );
    expect(parsed.id).toBe(ID);
    expect(parsed.accounts.id).toBe(TABLE);
  });

  it("documents leftover-byte behavior for appended contract fields", () => {
    const encoded = MemWalAccountBcs.serialize({
      id: ID,
      owner: OWNER,
      delegate_keys: [],
      created_at: BigInt(0),
      active: true,
    }).toBytes();
    const withTrailing = new Uint8Array(encoded.length + 2);
    withTrailing.set(encoded);
    withTrailing[encoded.length] = 0;
    withTrailing[encoded.length + 1] = 1;

    // If this throws, the live decoder will fail closed when the published
    // package grows trailing fields. If it parses, appended fields are
    // ignored and only *inserted* fields would silently decode wrong.
    const parseWithTrailing = () => MemWalAccountBcs.parse(withTrailing);
    try {
      const parsed = parseWithTrailing();
      expect(parsed.id).toBe(ID);
      expect(parsed.active).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
