import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import {
  buildSealEncryptId,
  fetchSealEncryptIdentity,
} from "../sidecar/seal-identity.js";

// These assertions pin the wire format against `account::seal_approve`, which
// reads the trailing 8 bytes as a BCS u64 and then matches owner ‖ counter.
// Drift here does not fail loudly — it mints ciphertext nobody can decrypt.

const OWNER = "0x" + "ab".repeat(32);
const PACKAGE = "0x" + "cd".repeat(32);

function accountClient(json: Record<string, unknown>, packageId = PACKAGE) {
  return {
    async getObject({ objectId }: { objectId: string }) {
      assert.equal(objectId, "0xaccount");
      return {
        object: {
          type: `${packageId}::account::MemWalAccount`,
          json,
        },
      };
    },
  };
}

test("the id is the owner address followed by the BCS little-endian counter", () => {
  const id = buildSealEncryptId(OWNER, 1n);
  assert.equal(id.length, 80, "32-byte owner + 8-byte counter, hex");
  assert.equal(id.slice(0, 64), "ab".repeat(32));
  // Little-endian, matching bcs::to_bytes(&1u64) on the Move side.
  assert.equal(id.slice(64), "0100000000000000");
});

test("counter 0 still occupies the full 8-byte tail", () => {
  // A bare owner id would be 64 chars and seal_approve's length check would
  // reject it, so the zero counter must not be elided.
  assert.equal(buildSealEncryptId(OWNER, 0n).slice(64), "0000000000000000");
});

test("a short-form owner address is normalized to the full 32 bytes", () => {
  // "0x1" would hex-decode to one byte, the on-chain suffix check would miss,
  // and the ciphertext would be undecryptable while encrypt reported success.
  const id = buildSealEncryptId("0x1", 0n);
  assert.equal(id.length, 80);
  assert.equal(id.slice(0, 64), normalizeSuiAddress("0x1").slice(2));
});

test("a normal active account yields its verified owner and counter", async () => {
  const client = accountClient({
    owner: OWNER,
    active: true,
    admin_quarantined: false,
    access_counter_version: "7",
  });
  assert.deepEqual(
    await fetchSealEncryptIdentity(
      "0xaccount",
      OWNER,
      PACKAGE,
      "normal",
      client
    ),
    {
      owner: normalizeSuiAddress(OWNER),
      immutablePackageId: normalizeSuiAddress(PACKAGE),
      accessCounterVersion: 7n,
    }
  );
});

test("an inactive account is allowed only for migration", async () => {
  const client = accountClient({
    owner: OWNER,
    active: false,
    admin_quarantined: false,
    access_counter_version: "7",
  });

  assert.deepEqual(
    await fetchSealEncryptIdentity(
      "0xaccount",
      OWNER,
      PACKAGE,
      "migration",
      client
    ),
    {
      owner: normalizeSuiAddress(OWNER),
      immutablePackageId: normalizeSuiAddress(PACKAGE),
      accessCounterVersion: 7n,
    }
  );
  await assert.rejects(
    () =>
      fetchSealEncryptIdentity("0xaccount", OWNER, PACKAGE, "normal", client),
    /is not active/
  );
});

test("only the legacy seed path accepts an active pre-quarantine account", async () => {
  const client = accountClient({
    owner: OWNER,
    active: true,
    access_counter_version: "7",
  });

  assert.deepEqual(
    await fetchSealEncryptIdentity(
      "0xaccount",
      OWNER,
      PACKAGE,
      "legacy-seed",
      client
    ),
    {
      owner: normalizeSuiAddress(OWNER),
      immutablePackageId: normalizeSuiAddress(PACKAGE),
      accessCounterVersion: 7n,
    }
  );
  for (const purpose of ["normal", "migration"] as const) {
    await assert.rejects(
      () =>
        fetchSealEncryptIdentity(
          "0xaccount",
          OWNER,
          PACKAGE,
          purpose,
          client
        ),
      /has no valid admin_quarantined field/
    );
  }
});

test("the legacy seed path still requires an active account", async () => {
  const client = accountClient({
    owner: OWNER,
    active: false,
    access_counter_version: "7",
  });
  await assert.rejects(
    () =>
      fetchSealEncryptIdentity(
        "0xaccount",
        OWNER,
        PACKAGE,
        "legacy-seed",
        client
      ),
    /is not active/
  );
});

test("admin quarantine blocks every encryption purpose", async () => {
  const client = accountClient({
    owner: OWNER,
    active: true,
    admin_quarantined: true,
    access_counter_version: "7",
  });

  for (const purpose of ["normal", "migration", "legacy-seed"] as const) {
    await assert.rejects(
      () =>
        fetchSealEncryptIdentity("0xaccount", OWNER, PACKAGE, purpose, client),
      /admin quarantined/
    );
  }
});

test("an account without the counter field is rejected rather than defaulted", async () => {
  // Defaulting to 0 here would silently encrypt under the identity a
  // just-removed delegate already holds a key for.
  const client = {
    async getObject() {
      return {
        object: {
          type: `${PACKAGE}::account::MemWalAccount`,
          json: { owner: OWNER, active: true, admin_quarantined: false },
        },
      };
    },
  };
  await assert.rejects(
    () =>
      fetchSealEncryptIdentity("0xaccount", OWNER, PACKAGE, "normal", client),
    /has no access_counter_version/
  );
});

test("a request owner cannot redirect encryption away from the on-chain owner", async () => {
  const client = {
    async getObject() {
      return {
        object: {
          type: `${PACKAGE}::account::MemWalAccount`,
          json: {
            owner: OWNER,
            active: true,
            admin_quarantined: false,
            access_counter_version: "7",
          },
        },
      };
    },
  };
  await assert.rejects(
    () =>
      fetchSealEncryptIdentity("0xaccount", "0x1", PACKAGE, "normal", client),
    /owner does not match request owner/
  );
});

test("an account from another immutable package is rejected", async () => {
  const client = {
    async getObject() {
      return {
        object: {
          type: `0x1::account::MemWalAccount`,
          json: { owner: OWNER, access_counter_version: "7" },
        },
      };
    },
  };
  await assert.rejects(
    () =>
      fetchSealEncryptIdentity("0xaccount", OWNER, PACKAGE, "normal", client),
    /is not a .*MemWalAccount/
  );
});
