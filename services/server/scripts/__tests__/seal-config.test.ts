import assert from "node:assert/strict";
import test from "node:test";

import { getSealServerConfigsFromEnv, getSealThresholdFromEnv } from "../seal-config.js";

const MYSTEN_TESTNET_COMMITTEE = {
    objectId: "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
    weight: 1,
    aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com",
};

const MYSTEN_TESTNET_INDEPENDENT_KEY_SERVERS = [
    {
        objectId: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75",
        weight: 1,
    },
    {
        objectId: "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8",
        weight: 1,
    },
];

const MYSTEN_TESTNET_INDEPENDENT_KEY_SERVER_IDS = MYSTEN_TESTNET_INDEPENDENT_KEY_SERVERS.map(
    ({ objectId }) => objectId,
).join(",");

test("SEAL_SERVER_CONFIGS overrides built-in defaults", () => {
    const configs = getSealServerConfigsFromEnv({
        SUI_NETWORK: "testnet",
        SEAL_SERVER_CONFIGS: JSON.stringify([
            {
                objectId: "0xcustom",
                weight: 3,
                aggregatorUrl: "https://seal-aggregator.example.com",
            },
        ]),
        SEAL_KEY_SERVERS: "0xlegacy",
    });

    assert.deepEqual(configs, [
        {
            objectId: "0xcustom",
            weight: 3,
            aggregatorUrl: "https://seal-aggregator.example.com",
        },
    ]);
});

test("SEAL_KEY_SERVERS remains the legacy independent-server override", () => {
    const configs = getSealServerConfigsFromEnv({
        SUI_NETWORK: "testnet",
        SEAL_KEY_SERVERS: "0xone, 0xtwo",
    });

    assert.deepEqual(configs, [
        { objectId: "0xone", weight: 1 },
        { objectId: "0xtwo", weight: 1 },
    ]);
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
        /SEAL_THRESHOLD must be less than or equal to total configured SEAL server weight/,
    );
});
