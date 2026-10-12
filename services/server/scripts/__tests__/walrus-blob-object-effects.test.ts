import assert from "node:assert/strict";
import test from "node:test";

import { uploadWalrusBlobWithEffectsRetry } from "../sidecar/routes/walrus-upload.js";
import {
    isUnseenSuiObject,
    isWalrusBlobObjectMissingFromEffects,
} from "../walrus-error-detection.js";

const OBJECT_ID = `0x${"ab".repeat(32)}`;
const UNSEEN = `Object ${OBJECT_ID} not found`;
const EFFECTS = "Blob object not found in transaction effects for transaction (digest)";

test("detects Walrus blob object missing from transaction effects", () => {
    const message =
        "walrus upload failed: Internal Error: walrus upload failed: " +
        "Blob object not found in transaction effects for transaction " +
        "(EZkVUtPRGGW8NehBemRpoxx6yHCxjNazVxgy3uiNj7Qc)";

    assert.equal(isWalrusBlobObjectMissingFromEffects(message), true);
});

test("matches case-insensitively", () => {
    assert.equal(
        isWalrusBlobObjectMissingFromEffects("blob object NOT found in TRANSACTION effects"),
        true,
    );
});

test("does not match unrelated Walrus or Enoki errors", () => {
    assert.equal(isWalrusBlobObjectMissingFromEffects("Sponsored transaction has expired"), false);
    assert.equal(isWalrusBlobObjectMissingFromEffects("Could not find the referenced object at version None"), false);
    assert.equal(isWalrusBlobObjectMissingFromEffects("Blob expired or not found across aggregators"), false);
    assert.equal(isWalrusBlobObjectMissingFromEffects(""), false);
    assert.equal(isWalrusBlobObjectMissingFromEffects(UNSEEN), false);
});

test("detects a gRPC getObject miss for one full object id", () => {
    assert.equal(isUnseenSuiObject(UNSEEN), true);
    assert.equal(isUnseenSuiObject(`walrus upload failed: ${UNSEEN}`), true);
    assert.equal(isUnseenSuiObject(`Object 0x${"AB".repeat(32)} NOT FOUND`), true);
});

test("does not treat effects lag or a short id as a cached getObject miss", () => {
    assert.equal(isUnseenSuiObject(EFFECTS), false);
    assert.equal(isUnseenSuiObject("Object 0xabc not found"), false);
    assert.equal(isUnseenSuiObject("Could not find the referenced object at version None"), false);
    assert.equal(isUnseenSuiObject("Blob expired or not found across aggregators"), false);
    assert.equal(isUnseenSuiObject(""), false);
});

test("retries a cached object miss and resets that client before the next try", async () => {
    const calls: unknown[] = [];
    const resets: number[] = [];
    const flow = {
        upload: async (value: unknown) => {
            calls.push(value);
            if (calls.length < 3) throw new Error(UNSEEN);
            return { step: "uploaded", blobId: "blob" };
        },
    };

    const result = await withSilencedWarn(() => uploadWalrusBlobWithEffectsRetry(
        flow,
        "register-digest",
        {
            traceId: "trace",
            jobId: "job",
            keyIndex: 4,
            resetWalrusCache: () => {
                resets.push(calls.length);
            },
            retryDelaysMs: [0, 0],
        },
        true,
    ));

    assert.deepEqual(result, { step: "uploaded", blobId: "blob" });
    assert.deepEqual(calls, [
        { digest: "register-digest", deletable: true },
        { digest: "register-digest", deletable: true },
        { digest: "register-digest", deletable: true },
    ]);
    // Reset after each failed try that still has a delay, not after success.
    assert.deepEqual(resets, [1, 2]);
});

test("drops the cached miss when the object is still unseen after the schedule", async () => {
    let calls = 0;
    let resets = 0;
    const flow = {
        upload: async () => {
            calls += 1;
            throw new Error(UNSEEN);
        },
    };

    await assert.rejects(
        () => withSilencedWarn(() => uploadWalrusBlobWithEffectsRetry(
            flow,
            "register-digest",
            {
                traceId: "trace",
                jobId: "job",
                keyIndex: 0,
                resetWalrusCache: () => {
                    resets += 1;
                },
                retryDelaysMs: [0],
            },
        )),
        (error: Error) => error.message === UNSEEN,
    );
    // One delayed retry, then the give-up path clears the loader too.
    assert.equal(calls, 2);
    assert.equal(resets, 2);
});

test("does not reset the Walrus client for an effects miss or a permanent error", async () => {
    let effectsCalls = 0;
    let resets = 0;
    const effectsFlow = {
        upload: async () => {
            effectsCalls += 1;
            if (effectsCalls === 1) throw new Error(EFFECTS);
            return { step: "uploaded" };
        },
    };
    await withSilencedWarn(() => uploadWalrusBlobWithEffectsRetry(
        effectsFlow,
        "register-digest",
        {
            traceId: "trace",
            keyIndex: 0,
            resetWalrusCache: () => {
                resets += 1;
            },
            retryDelaysMs: [0],
        },
    ));
    assert.equal(effectsCalls, 2);
    assert.equal(resets, 0);

    let permanentCalls = 0;
    await assert.rejects(
        () => uploadWalrusBlobWithEffectsRetry(
            {
                upload: async () => {
                    permanentCalls += 1;
                    throw new Error("Sponsored transaction has expired");
                },
            },
            "register-digest",
            {
                traceId: "trace",
                keyIndex: 0,
                resetWalrusCache: () => {
                    resets += 1;
                },
                retryDelaysMs: [0, 0],
            },
        ),
        /Sponsored transaction has expired/,
    );
    assert.equal(permanentCalls, 1);
    assert.equal(resets, 0);
});

async function withSilencedWarn<T>(run: () => Promise<T>): Promise<T> {
    const warn = console.warn;
    console.warn = () => {};
    try {
        return await run();
    } finally {
        console.warn = warn;
    }
}
