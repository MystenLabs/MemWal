import test from "node:test";
import assert from "node:assert/strict";
import { sealEncryptCommitteeFailure } from "../sidecar/routes/seal.js";
import type { SealCommitteeIdentity } from "../seal-config.js";

const actualIdentity: SealCommitteeIdentity = {
    servers: [
        { objectId: "0xseal-a", weight: 1 },
        { objectId: "0xseal-b", weight: 1 },
    ],
    threshold: 2,
};

test("a matching committee pin passes regardless of the enforcement flag", () => {
    for (const requireCommitteeIdentity of [false, true]) {
        assert.equal(
            sealEncryptCommitteeFailure(
                {
                    servers: [
                        { objectId: "0xseal-a", weight: 1 },
                        { objectId: "0xseal-b", weight: 1 },
                    ],
                    threshold: 2,
                },
                requireCommitteeIdentity,
                actualIdentity,
            ),
            null,
        );
    }
});

test("an omitted pin is allowed only while enforcement is off", () => {
    assert.equal(sealEncryptCommitteeFailure(undefined, false, actualIdentity), null);

    const failure = sealEncryptCommitteeFailure(undefined, true, actualIdentity);
    assert.ok(failure);
    assert.equal(failure.status, 400);
    assert.match(String(failure.body.error), /expectedSealCommitteeIdentity/);
    // Validation failures must not carry a retryable cause code.
    assert.equal(failure.body.code, undefined);
    assert.equal(failure.body.causeCode, undefined);
});

test("a committee mismatch is a non-retryable 409 SEAL_COMMITTEE_MISMATCH", () => {
    for (const requireCommitteeIdentity of [false, true]) {
        const failure = sealEncryptCommitteeFailure(
            { servers: [{ objectId: "0xother", weight: 1 }], threshold: 1 },
            requireCommitteeIdentity,
            actualIdentity,
        );
        assert.ok(failure);
        assert.equal(failure.status, 409);
        assert.equal(failure.body.code, "SEAL_COMMITTEE_MISMATCH");
        // The old retryable shape must be gone: no NO_SIDE_EFFECT, no
        // SHARED_SERVICE_UNAVAILABLE cause that would budget-free retry a
        // misconfigured pod forever.
        assert.equal(failure.body.causeCode, undefined);
        assert.deepEqual(failure.body.actualSealCommitteeIdentity, actualIdentity);
    }
});
