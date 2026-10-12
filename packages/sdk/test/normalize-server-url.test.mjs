import assert from "node:assert/strict";
import test from "node:test";

import { assertNonBlankText, normalizeServerUrl } from "../dist/utils.js";

function warningsFrom(run) {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        const value = run();
        return { value, warnings };
    } finally {
        console.warn = original;
    }
}

test("ipv6 loopback does not warn about plaintext HTTP", () => {
    for (const url of ["http://[::1]:8000", "http://[::1]", "http://[0:0:0:0:0:0:0:1]:8000"]) {
        const { value, warnings } = warningsFrom(() => normalizeServerUrl(url));
        assert.equal(value, url.replace(/\/$/, ""));
        assert.deepEqual(warnings, [], url);
    }
});

test("localhost and 127.0.0.1 stay exempt, a remote http host warns", () => {
    for (const url of ["http://localhost:8000", "http://127.0.0.1:8000", "http://foo.localhost"]) {
        const { warnings } = warningsFrom(() => normalizeServerUrl(url));
        assert.deepEqual(warnings, [], url);
    }
    const { value, warnings } = warningsFrom(() => normalizeServerUrl("http://relayer.example.com/"));
    assert.equal(value, "http://relayer.example.com");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /plaintext HTTP/);
});

test("whitespace-only text is rejected and surrounding spaces on a real fact are kept", () => {
    for (const text of ["", " ", "\t", "\n", "  \t\n "]) {
        assert.throws(() => assertNonBlankText(text), { message: "Text cannot be empty", status: 400 });
    }
    assert.doesNotThrow(() => assertNonBlankText("  hello  "));
    assert.throws(
        () => assertNonBlankText(" ", "items[0].text cannot be empty"),
        { message: "items[0].text cannot be empty", status: 400 },
    );
});
