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
