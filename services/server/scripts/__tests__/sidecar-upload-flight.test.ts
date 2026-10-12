import test from "node:test";
import assert from "node:assert/strict";

const {
    beginOrJoinUploadStepFlight,
    resetUploadStepFlightsForTests,
    settleUploadStepFlight,
    uploadStepFlightKey,
} = await import("../sidecar/routes/walrus-upload-journal.js");

test("a dropped upload retries the same step instead of starting another", async () => {
    resetUploadStepFlightsForTests();
    const key = uploadStepFlightKey("job-1", "encoded", "blob-1", "digest-1");
    const leader = beginOrJoinUploadStepFlight(key);
    const follower = beginOrJoinUploadStepFlight(key);
    assert.equal(leader.leader, true);
    assert.equal(follower.leader, false);
    let calls = 0;
    const body = { step: { step: "registered", blobId: "blob-1" } };
    const done = (async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        settleUploadStepFlight(key, leader.flight, { status: 200, body });
        return body;
    })();
    const followed = await follower.flight.promise;
    await done;
    assert.equal(calls, 1);
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.body, body);
    resetUploadStepFlightsForTests();
});

test("a different checkpoint is a different step", () => {
    assert.notEqual(
        uploadStepFlightKey("job-1", "encoded", "blob-1", undefined),
        uploadStepFlightKey("job-1", "registered", "blob-1", undefined),
    );
});
