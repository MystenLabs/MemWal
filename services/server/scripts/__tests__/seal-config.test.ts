import assert from "node:assert/strict";
import test from "node:test";

import {
  getSealCommitteeIdentity,
  getSealServerConfigsFromEnv,
  getSealThresholdFromEnv,
  sealCommitteeIdentityMatches,
} from "../seal-config.js";

const ID_ONE = `0x${"0".repeat(63)}1`;
const ID_TWO = `0x${"0".repeat(63)}2`;
const ID_THREE = `0x${"0".repeat(63)}3`;

const MYSTEN_TESTNET_COMMITTEE = {
  objectId:
    "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
  weight: 1,
  aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com",
};

const MYSTEN_TESTNET_INDEPENDENT_KEY_SERVERS = [
  {
    objectId:
      "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
    weight: 1,
  },
  {
    objectId:
      "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
    weight: 1,
  },
];

const MYSTEN_TESTNET_INDEPENDENT_KEY_SERVER_IDS =
  MYSTEN_TESTNET_INDEPENDENT_KEY_SERVERS.map(({ objectId }) => objectId).join(
    ","
  );

test("SEAL_SERVER_CONFIGS overrides built-in defaults", () => {
  const configs = getSealServerConfigsFromEnv({
    SUI_NETWORK: "testnet",
    SEAL_SERVER_CONFIGS: JSON.stringify([
      {
        objectId: "0x1",
        weight: 3,
        aggregatorUrl: "https://seal-aggregator.example.com",
      },
    ]),
    SEAL_KEY_SERVERS: "0x2",
  });

  assert.deepEqual(configs, [
    {
      objectId: ID_ONE,
      weight: 3,
      aggregatorUrl: "https://seal-aggregator.example.com",
    },
  ]);
});

test("SEAL_KEY_SERVERS remains the legacy independent-server override", () => {
  const configs = getSealServerConfigsFromEnv({
    SUI_NETWORK: "testnet",
    SEAL_KEY_SERVERS: "0x1, 0x2",
  });

  assert.deepEqual(configs, [
    { objectId: ID_ONE, weight: 1 },
    { objectId: ID_TWO, weight: 1 },
  ]);
});

test("duplicate and aliased SEAL server object IDs are rejected", () => {
  assert.throws(
    () => getSealServerConfigsFromEnv({ SEAL_KEY_SERVERS: "0x1,0x01" }),
    /object IDs must be unique/
  );
  assert.throws(
    () =>
      getSealServerConfigsFromEnv({
        SEAL_SERVER_CONFIGS: JSON.stringify([
          { objectId: "0x1", weight: 1 },
          { objectId: ID_ONE, weight: 1 },
        ]),
      }),
    /object IDs must be unique/
  );
});

test("SEAL weighted committee stays inside the SDK byte domain", () => {
  assert.throws(
    () =>
      getSealServerConfigsFromEnv({
        SEAL_SERVER_CONFIGS: JSON.stringify([
          { objectId: ID_ONE, weight: 255 },
        ]),
      }),
    /between 1 and 254/
  );
  assert.throws(
    () =>
      getSealServerConfigsFromEnv({
        SEAL_SERVER_CONFIGS: JSON.stringify([
          { objectId: ID_ONE, weight: 200 },
          { objectId: ID_TWO, weight: 55 },
        ]),
      }),
    /total configured SEAL server weight must be at most 254/
  );
  assert.throws(
    () =>
      getSealServerConfigsFromEnv({
        SEAL_SERVER_CONFIGS: JSON.stringify([
          { objectId: ID_ONE, weight: Number.MAX_SAFE_INTEGER + 1 },
        ]),
      }),
    /between 1 and 254/
  );
});

test("testnet defaults to the legacy Mysten independent key servers", () => {
  const configs = getSealServerConfigsFromEnv({ SUI_NETWORK: "testnet" });

  assert.deepEqual(configs, MYSTEN_TESTNET_INDEPENDENT_KEY_SERVERS);
});

test("mainnet keeps independent defaults until official committee is available", () => {
  const configs = getSealServerConfigsFromEnv({ SUI_NETWORK: "mainnet" });

  assert.equal(configs.length, 2);
  assert.ok(configs.every((config) => config.aggregatorUrl === undefined));
});

test("testnet independent default keeps threshold 2", () => {
  const configs = getSealServerConfigsFromEnv({ SUI_NETWORK: "testnet" });

  assert.equal(getSealThresholdFromEnv(configs, {}), 2);
});

test("legacy testnet independent override keeps threshold 2", () => {
  const configs = getSealServerConfigsFromEnv({
    SUI_NETWORK: "testnet",
    SEAL_KEY_SERVERS: MYSTEN_TESTNET_INDEPENDENT_KEY_SERVER_IDS,
  });

  assert.equal(configs.length, 2);
  assert.ok(configs.every((config) => config.aggregatorUrl === undefined));
  assert.equal(getSealThresholdFromEnv(configs, {}), 2);
});

test("Mysten committee aggregator remains available through SEAL_SERVER_CONFIGS", () => {
  const configs = getSealServerConfigsFromEnv({
    SUI_NETWORK: "testnet",
    SEAL_SERVER_CONFIGS: JSON.stringify([MYSTEN_TESTNET_COMMITTEE]),
  });

  assert.deepEqual(configs, [MYSTEN_TESTNET_COMMITTEE]);
  assert.equal(getSealThresholdFromEnv(configs, {}), 1);
});

test("explicit SEAL_THRESHOLD validation is unchanged", () => {
  const configs = getSealServerConfigsFromEnv({ SUI_NETWORK: "testnet" });

  assert.equal(getSealThresholdFromEnv(configs, { SEAL_THRESHOLD: "1" }), 1);
  assert.equal(getSealThresholdFromEnv(configs, { SEAL_THRESHOLD: "2" }), 2);
  assert.throws(
    () => getSealThresholdFromEnv(configs, { SEAL_THRESHOLD: "3" }),
    /SEAL_THRESHOLD must be less than or equal to total configured SEAL server weight/
  );
  assert.throws(
    () =>
      getSealThresholdFromEnv(configs, {
        SEAL_THRESHOLD: String(Number.MAX_SAFE_INTEGER + 1),
      }),
    /SEAL_THRESHOLD must be a positive integer/
  );
});

test("committee identity keeps configured order and excludes transport credentials", () => {
  const configs = getSealServerConfigsFromEnv({
    SEAL_SERVER_CONFIGS: JSON.stringify([
      {
        objectId: "0x2",
        weight: 2,
        aggregatorUrl: "https://seal.example.com",
        apiKeyName: "x-api-key",
        apiKey: "secret",
      },
      { objectId: "0x1", weight: 1 },
    ]),
  });

  assert.deepEqual(getSealCommitteeIdentity(configs, 2), {
    servers: [
      { objectId: ID_TWO, weight: 2 },
      { objectId: ID_ONE, weight: 1 },
    ],
    threshold: 2,
  });
});

test("committee identity comparison fences threshold, membership, weight, and order", () => {
  const actual = {
    servers: [
      { objectId: ID_ONE, weight: 1 },
      { objectId: ID_TWO, weight: 2 },
    ],
    threshold: 2,
  };
  assert.equal(sealCommitteeIdentityMatches(actual, actual), true);
  assert.equal(
    sealCommitteeIdentityMatches({ ...actual, threshold: 1 }, actual),
    false
  );
  assert.equal(
    sealCommitteeIdentityMatches(
      {
        ...actual,
        servers: [...actual.servers].reverse(),
      },
      actual
    ),
    false
  );
  assert.equal(
    sealCommitteeIdentityMatches(
      {
        ...actual,
        servers: [{ objectId: ID_THREE, weight: 9 }, actual.servers[1]],
      },
      actual
    ),
    false
  );
});
