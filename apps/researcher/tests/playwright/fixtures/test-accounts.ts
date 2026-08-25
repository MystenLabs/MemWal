/**
 * Fixture identities the delegate-account binding mock registers
 * (lib/auth/delegate-account.mock.ts — keep the two lists in sync).
 *
 * Each account id maps to exactly one delegate private key, so wrong-key and
 * unknown-account logins fail the same way they would against the chain.
 */
export type TestAccount = {
  accountId: string;
  privateKey: string;
};

export const TEST_ACCOUNT_A: TestAccount = {
  accountId: `0x${"aa".repeat(32)}`,
  privateKey: "a".repeat(64),
};

export const TEST_ACCOUNT_B: TestAccount = {
  accountId: `0x${"bb".repeat(32)}`,
  privateKey: "b".repeat(64),
};

/** Valid 64-hex key that is NOT registered on any fixture account. */
export const UNREGISTERED_PRIVATE_KEY = "c".repeat(64);

/** Well-formed account id the binding mock has never heard of. */
export const UNKNOWN_ACCOUNT_ID = `0x${"cc".repeat(32)}`;
