import assert from "node:assert/strict";
import test from "node:test";
import { delegateAccountBindingError } from "./delegate-account";

const PACKAGE_ID = `0x${"2".repeat(64)}`;
const PUBLIC_KEY = "ab".repeat(32);

test("Researcher delegate login requires an active matching on-chain key", () => {
  assert.equal(
    delegateAccountBindingError(
      `${PACKAGE_ID}::account::MemWalAccount`,
      {
        active: true,
        delegate_keys: [{ public_key: PUBLIC_KEY }],
      },
      { packageId: PACKAGE_ID, publicKeyHex: PUBLIC_KEY }
    ),
    null
  );

  assert.match(
    delegateAccountBindingError(
      `${PACKAGE_ID}::account::MemWalAccount`,
      {
        active: true,
        delegate_keys: [{ public_key: "cd".repeat(32) }],
      },
      { packageId: PACKAGE_ID, publicKeyHex: PUBLIC_KEY }
    ) ?? "",
    /not registered/
  );
});
