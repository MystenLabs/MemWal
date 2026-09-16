import test from "node:test";
import assert from "node:assert/strict";
import { formatRestoreResult } from "../tools/restore.js";

test("memwal_restore warns when the API reports a truncated restore", () => {
    const text = formatRestoreResult(
        {
            namespace: "my-app",
            total: 25,
            restored: 10,
            skipped: 15,
            truncated: true,
        },
        10,
    );

    assert.match(text, /^Restore partially complete/);
    assert.match(text, /truncated=true/);
    assert.match(text, /More blobs remain to restore/);
    assert.match(text, /increase limit and call again/);
    assert.doesNotMatch(text, /Sidecar cap is saturated/);
});

test("memwal_restore does not tell agents to raise limit once the sidecar cap is saturated", () => {
    const text = formatRestoreResult(
        {
            namespace: "my-app",
            total: 100,
            restored: 20,
            skipped: 80,
            truncated: true,
        },
        20,
    );

    assert.match(text, /^Restore partially complete/);
    assert.match(text, /truncated=true/);
    assert.match(text, /Sidecar cap is saturated/);
    assert.match(text, /missing-blob page/);
    assert.doesNotMatch(text, /increase limit and call again/);
});

test("memwal_restore reports a finished page when restore is not truncated", () => {
    const text = formatRestoreResult({
        namespace: "my-app",
        total: 10,
        restored: 10,
        skipped: 0,
        truncated: false,
    });

    assert.match(text, /^Restore page finished/);
    assert.match(text, /truncated=false/);
    assert.match(text, /not proof the sidecar saw every blob/);
    assert.doesNotMatch(text, /More blobs remain to restore/);
    assert.doesNotMatch(text, /Restore complete/);
});

test("memwal_restore treats an omitted legacy truncated field as false", () => {
    const text = formatRestoreResult({
        namespace: "legacy",
        total: 1,
        restored: 1,
        skipped: 0,
    });

    assert.match(text, /^Restore page finished/);
    assert.match(text, /truncated=false/);
    assert.match(text, /not proof the sidecar saw every blob/);
});

test("memwal_restore prints failed next to the other counts", () => {
    const text = formatRestoreResult({
        namespace: "my-app",
        total: 10,
        restored: 7,
        skipped: 0,
        failed: 3,
        truncated: false,
    });

    assert.match(text, /failed=3/);
    assert.match(text, /restored=7/);
    assert.match(text, /skipped=0/);
});

test("memwal_restore defaults omitted failed to 0", () => {
    const text = formatRestoreResult({
        namespace: "legacy",
        total: 1,
        restored: 1,
        skipped: 0,
        truncated: false,
    });

    assert.match(text, /failed=0/);
});

test("memwal_restore hints retry not raise-limit when the page is only transients", () => {
    const text = formatRestoreResult(
        {
            namespace: "my-app",
            total: 10,
            restored: 0,
            skipped: 0,
            failed: 0,
            truncated: true,
        },
        10,
    );

    assert.match(text, /^Restore partially complete/);
    assert.match(text, /failed=0/);
    assert.match(text, /download\/embed blip/);
    assert.match(text, /retry the same limit/);
    assert.doesNotMatch(text, /increase limit and call again/);
});

test("memwal_restore still tells agents to raise limit for WALM-431 cap truncation", () => {
    // Empty namespace, sidecar cap still expandable (limit < 20): skipped+failed
    // is not short of total, so this is page/cap truncation, not an embed blip.
    //
    // The ACTION here is unchanged and still correct — raising limit does grow
    // discovery while limit < 20. What changed is the claim attached to it: the
    // old wording was "More blobs remain to restore", which asserts something
    // this page never observed. With total=0 nothing was seen at all, so the
    // agent was being told a fact in order to justify a retry. It now gets the
    // same instruction with the real reason (the owner-wide candidate cap was
    // reached, so this namespace may not have been looked at).
    const text = formatRestoreResult(
        {
            namespace: "my-app",
            total: 0,
            restored: 0,
            skipped: 0,
            failed: 0,
            truncated: true,
        },
        10,
    );

    assert.match(text, /Raise limit/, "the actionable advice must survive");
    assert.doesNotMatch(text, /download\/embed blip/);
    assert.doesNotMatch(
        text,
        /More blobs remain/,
        "an empty page has seen nothing that says blobs remain",
    );
});

// Observed live on 0.0.13-dev.6 against dev, restoring a namespace that had
// just been written to but whose blobs were not yet on chain:
//
//   total=0  restored=0  skipped=0  failed=0  truncated=true
//   ⚠️ More blobs remain to restore — increase limit and call again.
//
// Nothing had been seen that said blobs remain. `truncated` was true only
// because the sidecar's candidate cap is owner-wide and other namespaces had
// saturated it (routes/admin.rs `restore_is_truncated`, the `limit < 20` arm),
// so an agent following that advice loops on an empty namespace.
test("an empty page never claims blobs remain", () => {
    const text = formatRestoreResult(
        { namespace: "fresh-ns", total: 0, restored: 0, skipped: 0, failed: 0, truncated: true },
        5,
    );
    assert.doesNotMatch(
        text,
        /More blobs remain/,
        "nothing was seen that says blobs remain — this is the loop the agent gets stuck in",
    );
    assert.match(text, /No blobs found for this namespace/);
    // The reason truncated is set must be named, or the count and the flag
    // read as a contradiction.
    assert.match(text, /candidate cap/);
    assert.match(text, /Raise limit to widen the search/);
});

test("an empty page at the saturated limit says the namespace is empty", () => {
    const text = formatRestoreResult(
        { namespace: "typo-ns", total: 0, restored: 0, skipped: 0, failed: 0, truncated: true },
        100,
    );
    assert.match(text, /almost certainly empty/);
    assert.doesNotMatch(text, /Raise limit/);
});

test("an empty page that is not truncated says so plainly", () => {
    const text = formatRestoreResult(
        { namespace: "gone", total: 0, restored: 0, skipped: 0, failed: 0, truncated: false },
        10,
    );
    assert.match(text, /Nothing to restore/);
    assert.doesNotMatch(text, /truncated=false is not proof/);
});

test("a real truncated page still tells the agent to raise limit", () => {
    // Guard against over-correcting: the empty-page branch must not swallow
    // the case it was carved out of.
    const text = formatRestoreResult(
        { namespace: "my-app", total: 25, restored: 10, skipped: 15, truncated: true },
        10,
    );
    assert.match(text, /More blobs remain to restore/);
});

