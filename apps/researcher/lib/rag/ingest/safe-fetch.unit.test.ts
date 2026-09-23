import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, globalAgent } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { ChatbotError } from "@/lib/errors";
import {
  assertPublicDestination,
  assertPublicUrl,
  fetchFirstReachable,
  fetchPinned,
  fetchPublicUrl,
  isBlockedAddress,
  PinnedConnectError,
  type PinnedTransport,
  pinnedRequestOptions,
} from "./safe-fetch";
import { createServer as createTcpServer } from "node:net";

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
  "::ffff:7f00:1",
  "::ffff:169.254.169.254",
  "64:ff9b::7f00:1",
  // Deprecated IPv4-compatible and SIIT embeddings of loopback.
  "::7f00:1",
  "::ffff:0:7f00:1",
  // IPv6 multicast; v4 multicast 224.0.0.1 is already in the list above.
  "ff02::1",
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
  // Unwrap, do not blanket-block: public IPv4 via compatible / SIIT stays public.
  "::8.8.8.8",
  "::ffff:0:8.8.8.8",
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
  // A client that followed redirects itself would skip the check on the new
  // target, so fetchPublicUrl follows by hand and re-checks each hop. The
  // transport is injected to stage a public first hop: there is no public
  // address a unit test may actually dial.
  const requested: string[] = [];

  const transport: PinnedTransport = async (url, address) => {
    requested.push(`${url.toString()} via ${address}`);

    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    });
  };

  await assertRejectedWith(
    () => fetchPublicUrl("https://8.8.8.8/file.pdf", undefined, transport),
    /private or reserved address/
  );
  // Only the first, allowed hop was ever sent — and it was pinned to the
  // address that hop validated to.
  assert.deepEqual(requested, ["https://8.8.8.8/file.pdf via 8.8.8.8"]);
});

test("fetchPublicUrl maps a malformed redirect Location to ChatbotError", async () => {
  // new URL(location, url) throws TypeError on a broken Location. Without a
  // catch, chat's generic handler turns that into offline:chat (503) instead
  // of the same 400 assertPublicUrl uses for a bad user-supplied URL.
  const requested: string[] = [];

  const transport: PinnedTransport = async (url) => {
    requested.push(url.toString());

    return new Response(null, {
      status: 302,
      headers: { location: "http://[" },
    });
  };

  await assertRejectedWith(
    () => fetchPublicUrl("https://8.8.8.8/file.pdf", undefined, transport),
    /Invalid URL format/
  );
  assert.deepEqual(requested, ["https://8.8.8.8/file.pdf"]);
});

// ── WALM-682: the connection is pinned to the address that was validated ──
//
// The checks above all stop at "was this destination allowed?". They cannot see
// the gap the report named: assertPublicUrl resolved the host, approved the
// answer, and then handed the *name* back to a client that resolved it a second
// time. Nothing tied the two answers together, so a host could return a public
// address to the check and a private one to the connection.

test("the connection goes to the pinned address, not to a re-resolved name", async (t) => {
  // The URL names example.com — a host that really does resolve, to a real
  // public address. The pinned address is this loopback server. If the client
  // re-resolved the name, the request would leave the machine and never arrive
  // here, so the handler running at all is the proof that the pin held.
  let seenHost: string | undefined;
  let seenPath: string | undefined;

  const server = createServer((request, response) => {
    seenHost = request.headers.host;
    seenPath = request.url ?? "";
    response.end("pinned");
  });
  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  t.after(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
      })
  );

  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetchPinned(
    new URL(`http://example.com:${address.port}/doc.pdf?x=1`),
    "127.0.0.1",
    undefined,
    5000
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "pinned");
  assert.equal(seenPath, "/doc.pdf?x=1");
  // Pinned by address, still addressed to the original host: name-based virtual
  // hosts and TLS identity both depend on this staying the hostname.
  assert.equal(seenHost, `example.com:${address.port}`);
});

test("pinnedRequestOptions separates where we connect from who we talk to", () => {
  const options = pinnedRequestOptions(
    new URL("https://files.example.com/a/b.pdf?q=1"),
    "203.0.113.10"
  );

  assert.equal(options.host, "203.0.113.10", "dials the validated address");
  assert.equal(options.port, 443);
  assert.equal(options.path, "/a/b.pdf?q=1");
  assert.equal(options.headers.host, "files.example.com");
  // Certificates are still verified against the hostname, so pinning the
  // address does not buy SSRF protection at the cost of TLS.
  assert.equal(options.servername, "files.example.com");
  assert.equal(options.rejectUnauthorized, true);
});

test("a non-default port travels in the Host header", () => {
  const options = pinnedRequestOptions(
    new URL("https://files.example.com:8443/x"),
    "203.0.113.10"
  );

  assert.equal(options.port, 8443);
  assert.equal(options.headers.host, "files.example.com:8443");
});

test("an IP literal gets no SNI but still verifies its certificate", () => {
  // SNI is a hostname extension; for a literal the certificate has to carry the
  // address itself, and rejectUnauthorized is what enforces that.
  const options = pinnedRequestOptions(
    new URL("https://203.0.113.10/x"),
    "203.0.113.10"
  );

  assert.equal(options.servername, undefined);
  assert.equal(options.rejectUnauthorized, true);
});

test("assertPublicDestination carries the validated addresses out", async () => {
  // assertPublicUrl threw the addresses away; that is what made pinning
  // impossible for the caller.
  const { addresses, url } = await assertPublicDestination(
    "https://203.0.113.10/x.pdf"
  );

  assert.deepEqual(addresses, ["203.0.113.10"]);
  assert.equal(url.hostname, "203.0.113.10");
});

// ── review follow-ups on #984 ─────────────────────────────────────────────

/**
 * A raw TCP listener that writes `reply` verbatim, so a test can send status
 * lines no well-behaved HTTP server would produce.
 */
async function rawServer(reply: string) {
  const server = createTcpServer((socket) => {
    socket.once("data", () => {
      socket.end(reply);
    });
  });
  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}

for (const [label, reply] of [
  ["status 600", "HTTP/1.1 600 Nope\r\nContent-Length: 0\r\n\r\n"],
  ["status 101 without an upgrade", "HTTP/1.1 101 Switching\r\nContent-Length: 0\r\n\r\n"],
  ["a control character in the reason phrase", "HTTP/1.1 200 O\x01K\r\nContent-Length: 2\r\n\r\nok"],
] as const) {
  test(`a response with ${label} settles the promise instead of crashing`, async (t) => {
    // Response() throws on these. Thrown inside the http callback, that was an
    // uncaughtException — the process exits by default — and the promise never
    // settled. Either outcome is fine here as long as it is an outcome.
    const { port, close } = await rawServer(reply);
    t.after(close);

    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    t.after(() => process.off("uncaughtException", onCrash));

    const outcome = await Promise.race([
      fetchPinned(
        new URL(`http://example.com:${port}/x`),
        "127.0.0.1",
        undefined,
        5000
      ).then(
        (response) => ({ settled: "resolved", status: response.status }),
        (error) => ({ settled: "rejected", error })
      ),
      new Promise((done) => setTimeout(() => done({ settled: "hung" }), 3000)),
    ]);

    assert.deepEqual(crashes, [], "nothing may escape as an uncaughtException");
    assert.notEqual(
      (outcome as { settled: string }).settled,
      "hung",
      "the promise must settle"
    );
    if ((outcome as { settled: string }).settled === "rejected") {
      assert.ok((outcome as { error: unknown }).error instanceof ChatbotError);
    }
  });
}

test("a refused connection is a PinnedConnectError, so the next address gets a turn", async () => {
  // Bind and release a port so nothing is listening on it.
  const { port, close } = await rawServer("");
  await close();

  await assert.rejects(
    () =>
      fetchPinned(new URL(`http://example.com:${port}/`), "127.0.0.1", undefined, 5000),
    (error) => error instanceof PinnedConnectError
  );
});

test("fetchFirstReachable falls through unreachable addresses in order", async () => {
  // The resolver often lists AAAA first; with no IPv6 egress the first address
  // fails to connect and the validated A record behind it should be used.
  const tried: string[] = [];
  const transport: PinnedTransport = async (_url, address) => {
    tried.push(address);
    if (address === "2001:db8::1") {
      throw new PinnedConnectError("bad_request:api", "ENETUNREACH");
    }
    return new Response("ok");
  };

  const response = await fetchFirstReachable(
    new URL("https://files.example.com/x.pdf"),
    ["2001:db8::1", "203.0.113.10"],
    undefined,
    transport
  );

  assert.equal(await response.text(), "ok");
  assert.deepEqual(tried, ["2001:db8::1", "203.0.113.10"]);
});

test("fetchFirstReachable does not retry once an address has connected", async () => {
  // After a connection the address worked; a TLS or HTTP failure is the
  // server's answer and trying a sibling address would just ask twice.
  const tried: string[] = [];
  const transport: PinnedTransport = async (_url, address) => {
    tried.push(address);
    throw new ChatbotError("bad_request:api", "certificate has expired");
  };

  await assert.rejects(
    () =>
      fetchFirstReachable(
        new URL("https://files.example.com/x.pdf"),
        ["203.0.113.10", "203.0.113.11"],
        undefined,
        transport
      ),
    /./
  );
  assert.deepEqual(tried, ["203.0.113.10"]);
});

test("fetchFirstReachable reports the last failure when every address is unreachable", async () => {
  const transport: PinnedTransport = async (_url, address) => {
    throw new PinnedConnectError("bad_request:api", `unreachable ${address}`);
  };

  await assertRejectedWith(
    () =>
      fetchFirstReachable(
        new URL("https://files.example.com/x.pdf"),
        ["203.0.113.10", "203.0.113.11"],
        undefined,
        transport
      ),
    /unreachable 203\.0\.113\.11/
  );
});

// ── round 2 on #984: a connect that hangs, not one that is refused ────────

// TEST-NET-1 (RFC 5737): never routed, so a connect to it hangs until something
// gives up — the blackholed-AAAA case, as opposed to an immediate refusal.
const BLACKHOLE = "192.0.2.1";

async function liveServer(t: { after: (fn: () => unknown) => void }) {
  const server = createServer((_request, response) => response.end("reached"));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

test("a blackholed first address gives way to the next one at the connect deadline", async (t) => {
  const port = await liveServer(t);
  const transport: PinnedTransport = (url, address, init, timeoutMs) =>
    fetchPinned(url, address, init, timeoutMs, 300);

  const started = Date.now();
  const response = await fetchFirstReachable(
    new URL(`http://example.com:${port}/x`),
    [BLACKHOLE, "127.0.0.1"],
    undefined,
    transport
  );

  assert.equal(await response.text(), "reached");
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});

test("the global agent's socket timer cannot end a connect early as a whole-fetch failure", async (t) => {
  // Node >=19 creates http(s).globalAgent with timeout: 5000, armed while the
  // socket is still connecting. It used to fire first, surface as the request
  // 'timeout', and reject with a plain ChatbotError — so the address fallback
  // never ran and the 10s connect deadline never fired. The agent timeout is
  // shrunk here to show the ordering without waiting five seconds.
  // `options` is real at runtime but missing from @types/node's Agent.
  const agentOptions = (globalAgent as unknown as { options: { timeout?: number } })
    .options;
  const previous = agentOptions.timeout;
  agentOptions.timeout = 100;
  t.after(() => {
    agentOptions.timeout = previous;
  });

  const started = Date.now();
  await assert.rejects(
    () => fetchPinned(new URL("http://example.com/x"), BLACKHOLE, undefined, 30_000, 600),
    (error) => {
      assert.ok(
        error instanceof PinnedConnectError,
        `expected PinnedConnectError, got ${(error as Error)?.constructor?.name}: ${String((error as ChatbotError).cause)}`
      );
      return true;
    }
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 500, `rejected at ${elapsed}ms — the agent's 100ms timer ended it, not the connect deadline`);
});
