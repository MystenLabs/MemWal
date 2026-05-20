import assert from "node:assert/strict";
import test from "node:test";

import { getSealServerConfigsFromEnv, getSealThresholdFromEnv } from "../seal-config.js";

const MYSTEN_TESTNET_COMMITTEE = {
    objectId: "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98",
    weight: 1,
    aggregatorUrl: "https://seal-aggregator-testnet.mystenlabs.com",
};

const PREVIOUS_TESTNET_INDEPENDENT_KEY_SERVERS =
    "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75," +
    "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8";

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

test("testnet defaults to Mysten committee aggregator", () => {
    const configs = getSealServerConfigsFromEnv({ SUI_NETWORK: "testnet" });

    assert.deepEqual(configs, [MYSTEN_TESTNET_COMMITTEE]);
});

test("mainnet keeps independent defaults until official committee is available", () => {
    const configs = getSealServerConfigsFromEnv({ SUI_NETWORK: "mainnet" });

    assert.equal(configs.length, 2);
    assert.ok(configs.every((config) => config.aggregatorUrl === undefined));
});

test("single committee default has threshold 1", () => {
    const configs = getSealServerConfigsFromEnv({ SUI_NETWORK: "testnet" });

    assert.equal(getSealThresholdFromEnv(configs, {}), 1);
});

test("legacy testnet independent override keeps threshold 2", () => {
    const configs = getSealServerConfigsFromEnv({
        SUI_NETWORK: "testnet",
        SEAL_KEY_SERVERS: PREVIOUS_TESTNET_INDEPENDENT_KEY_SERVERS,
    });

    assert.equal(configs.length, 2);
    assert.ok(configs.every((config) => config.aggregatorUrl === undefined));
    assert.equal(getSealThresholdFromEnv(configs, {}), 2);
});

test("explicit SEAL_THRESHOLD validation is unchanged", () => {
    const configs = getSealServerConfigsFromEnv({ SUI_NETWORK: "testnet" });

    assert.equal(getSealThresholdFromEnv(configs, { SEAL_THRESHOLD: "1" }), 1);
    assert.throws(
        () => getSealThresholdFromEnv(configs, { SEAL_THRESHOLD: "2" }),
        /SEAL_THRESHOLD must be less than or equal to total configured SEAL server weight/,
    );
});
