import { describe, expect, it } from "vitest";
import {
  DELEGATE_FIXTURE_COUNT,
  TEST_DELEGATE_ACCOUNTS,
  delegateFixtureAt,
  findDelegateFixture,
} from "./delegate-fixtures";

describe("delegate fixtures", () => {
  it("builds a unique deterministic pool", () => {
    expect(TEST_DELEGATE_ACCOUNTS).toHaveLength(DELEGATE_FIXTURE_COUNT);

    const accountIds = new Set(TEST_DELEGATE_ACCOUNTS.map((a) => a.accountId));
    const privateKeys = new Set(TEST_DELEGATE_ACCOUNTS.map((a) => a.privateKey));
    expect(accountIds.size).toBe(DELEGATE_FIXTURE_COUNT);
    expect(privateKeys.size).toBe(DELEGATE_FIXTURE_COUNT);

    expect(delegateFixtureAt(0)).toEqual({
      accountId: `0x${"00".repeat(32)}`,
      owner: `0x${"80".repeat(32)}`,
      privateKey: "40".repeat(32),
    });
  });

  it("looks up by account id case-insensitively", () => {
    const fixture = delegateFixtureAt(1);
    expect(findDelegateFixture(fixture.accountId.toUpperCase())).toEqual(fixture);
    expect(findDelegateFixture(`0x${"ff".repeat(32)}`)).toBeUndefined();
  });

  it("throws instead of wrapping past the pool", () => {
    expect(() => delegateFixtureAt(DELEGATE_FIXTURE_COUNT)).toThrow(/out of range/);
    expect(() => delegateFixtureAt(-1)).toThrow(/out of range/);
  });
});
