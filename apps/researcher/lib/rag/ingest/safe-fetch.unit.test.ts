import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { ChatbotError } from "@/lib/errors";
import { assertPublicUrl, fetchPublicUrl, isBlockedAddress } from "./safe-fetch";

// Regression tests for issue #778: a PDF file part named a URL that the server
// downloaded with a bare fetch, so a chat request could make the server call
// loopback services, RFC1918 neighbours, or the metadata endpoint. The addresses
// below are the ones an SSRF probe reaches for, plus the encodings that walked
// straight through the old prefix-matching denylist in extractUrlsFromText.

const BLOCKED = [
  // The address from the report.
  "127.0.0.1",
  // Loopback outside .0.1, which a prefix match on "127.0.0.1" misses.
  "127.1.2.3",
  "0.0.0.0",
  // Cloud metadata, absent from the old denylist altogether.
  "169.254.169.254",
  "169.254.0.1",
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "100.64.0.1",
  "192.0.0.1",
  "198.18.0.1",
  "224.0.0.1",
  "255.255.255.255",
  // IPv6 loopback, in both the compressed and the written-out form.
  "::1",
  "0:0:0:0:0:0:0:1",
  "::",
  "fd00::1",
  "fc00::1",
  "fe80::1",
  // Zone ids still name an interface-local target.
  "fe80::1%eth0",
  // IPv4-mapped and NAT64 forms both carry a blocked IPv4 destination.
  "::ffff:127.0.0.1",
  "::ffff:169.254.169.254",
  "64:ff9b::7f00:1",
];

const ALLOWED = [
  "8.8.8.8",
  "1.1.1.1",
  "93.184.216.34",
  "172.32.0.1",
  "172.15.255.255",
  "128.0.0.1",
  "2606:4700:4700::1111",
  "::ffff:8.8.8.8",
];

// ChatbotError puts the caller-facing detail in `cause` and leaves `message` as
// the generic copy for the error code, so assertions read `cause`.
async function rejectionOf(
  call: () => Promise<unknown>
): Promise<ChatbotError> {
  try {
    await call();
  } catch (error) {
    assert.ok(error instanceof ChatbotError, `unexpected error type: ${error}`);
    return error;
  }

  throw new Error("expected the call to reject");
}

async function assertRejectedWith(
  call: () => Promise<unknown>,
  detail: RegExp
): Promise<void> {
  const error = await rejectionOf(call);

  assert.equal(error.statusCode, 400);
  assert.match(String(error.cause), detail);
}

test("isBlockedAddress rejects loopback, private, link-local, and reserved addresses", () => {
  for (const address of BLOCKED) {
    assert.equal(isBlockedAddress(address), true, `expected blocked: ${address}`);
  }
});

test("isBlockedAddress allows public addresses", () => {
  for (const address of ALLOWED) {
    assert.equal(isBlockedAddress(address), false, `expected allowed: ${address}`);
  }
});

test("isBlockedAddress treats anything unparseable as blocked", () => {
  for (const address of ["", "not-an-ip", "127.0.0.256", "1.2.3", "gg::1", "::1::2"]) {
    assert.equal(isBlockedAddress(address), true, `expected blocked: ${address}`);
  }
});

test("assertPublicUrl rejects the URL from the report", async () => {
  await assertRejectedWith(
    () => assertPublicUrl("http://127.0.0.1:9999/ssrf-proof-token-abc123"),
    /private or reserved address/
  );
});

test("assertPublicUrl rejects a loopback host hidden behind userinfo", async () => {
  // The old denylist anchored on "http://127.0.0.1", so a username in front of
  // the host was enough to slip past it.
  await assertRejectedWith(
    () => assertPublicUrl("http://user@127.0.0.1/admin"),
    /private or reserved address/
  );
});

test("assertPublicUrl rejects bracketed IPv6 loopback", async () => {
  await assertRejectedWith(
    () => assertPublicUrl("http://[::1]:9999/probe"),
    /private or reserved address/
  );
});

test("assertPublicUrl rejects the metadata endpoint", async () => {
  await assertRejectedWith(
    () => assertPublicUrl("http://169.254.169.254/latest/meta-data/"),
    /private or reserved address/
  );
});

test("assertPublicUrl rejects a hostname that resolves to loopback", async () => {
  // localhost is a name, not a literal, so only resolution catches it.
  await assertRejectedWith(
    () => assertPublicUrl("http://localhost:3000/probe"),
    /private or reserved address/
  );
});

test("assertPublicUrl rejects non-HTTP schemes", async () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com/",
  ]) {
    await assertRejectedWith(() => assertPublicUrl(url), /Unsupported URL scheme/);
  }
});

test("assertPublicUrl rejects a malformed URL", async () => {
  await assertRejectedWith(
    () => assertPublicUrl("not a url"),
    /Invalid URL format/
  );
});

test("assertPublicUrl accepts a public literal without touching DNS", async () => {
  const url = await assertPublicUrl("https://8.8.8.8/file.pdf");

  assert.equal(url.hostname, "8.8.8.8");
  assert.equal(url.pathname, "/file.pdf");
});

test("fetchPublicUrl sends nothing to a loopback listener", async () => {
  // The report proved the bug by watching a listener log "CAPTURED REQUEST".
  // Asserting on the listener, rather than only on the rejection, is what shows
  // the request is refused before it leaves rather than after.
  const captured: string[] = [];
  const server = createServer((request, response) => {
    captured.push(request.url ?? "");
    response.end("ok");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await assertRejectedWith(
      () => fetchPublicUrl(`http://127.0.0.1:${address.port}/ssrf-proof-token`),
      /private or reserved address/
    );
    assert.deepEqual(captured, []);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

// The guard only helps where it is wired in, and the module that had the bug
// cannot be imported here: it pulls in chunking.ts, whose "server-only" import
// throws under node --test. Reading the source is what pins the call site, so
// restoring the bare fetch fails a test rather than passing quietly.
test("ingest downloads the PDF through the guard rather than bare fetch", () => {
  const ingest = readFileSync(resolve("lib/rag/ingest/index.ts"), "utf8");

  assert.match(ingest, /await fetchPublicUrl\(source\.fileUrl\)/);
  assert.doesNotMatch(ingest, /await fetch\(/);
});

test("fetchPublicUrl refuses a redirect into a blocked range", async () => {
  // fetch would follow a redirect itself, skipping the check on the new target,
  // so fetchPublicUrl follows by hand and re-checks each hop. Stubbing fetch is
  // the only way to stage a public first hop from a test.
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));

    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    });
  }) as typeof fetch;

  try {
    await assertRejectedWith(
      () => fetchPublicUrl("https://8.8.8.8/file.pdf"),
      /private or reserved address/
    );
    // Only the first, allowed hop was ever requested.
    assert.deepEqual(requested, ["https://8.8.8.8/file.pdf"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
