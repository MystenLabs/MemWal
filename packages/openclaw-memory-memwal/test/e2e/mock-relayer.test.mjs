/**
 * E2E against a deliberately misbehaving relayer served from this process.
 *
 * Needs no credentials and touches no network, so it is safe to run anywhere.
 * Covers the failure modes a real relayer shows under load: rate limiting,
 * 5xx, and the one that actually bit us, a socket held open with no reply.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { parseConfig } from "../../dist/config.js";
import { registerHooks } from "../../dist/hooks/index.js";

const CREDS = {
  privateKey: "a".repeat(64),
  accountId: "0x" + "1".repeat(40),
};

/** Enough of /health that the SDK's compatibility gate is satisfied. */
const HEALTH = {
  status: "ok",
  version: "0.1.0",
  relayerVersion: "0.1.0",
  apiVersion: "1.0.0",
  minSupportedSdk: { typescript: "0.0.4", python: "0.1.0", mcp: "0.0.1" },
  featureFlags: {},
  deprecations: [],
  mode: "production",
};

/**
 * Start a relayer that answers /health normally and fails everything else in
 * the requested way. `mode: "hang"` accepts the socket and never replies.
 */
async function startMockRelayer(mode) {
  const hits = [];
  const server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(HEALTH));
    }
    hits.push(`${req.method} ${req.url}`);
    if (mode === "hang") return; // never respond
    if (mode === "429") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
      return res.end(JSON.stringify({ error: "rate limited" }));
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => {
    // Force-close live sockets first. withTimeout races the request rather
    // than aborting it, because recall() builds its own AbortController and
    // takes no external signal, so the abandoned fetch keeps its socket open
    // and a plain server.close() would block until the OS gives up. That leak
    // is real in production too; here it would simply hang CI.
    server.closeAllConnections?.();
    server.close(r);
  });
  return { url, hits, close };
}

function makeApi() {
  const hooks = {};
  const logs = [];
  const push = (m) => logs.push(m);
  return {
    hooks,
    logs,
    api: {
      on: (event, fn) => { hooks[event] = fn; },
      registerTool: () => {}, registerCli: () => {}, registerService: () => {},
      logger: { info: push, warn: push, debug: push, error: push },
    },
  };
}

const GOOD_TURN = "I prefer TypeScript over Rust for backend services at work";

test("429 degrades instead of breaking the turn", async () => {
  const relayer = await startMockRelayer("429");
  try {
    const cfg = parseConfig({ ...CREDS, serverUrl: relayer.url, requestTimeoutMs: 5000 });
    const { MemWal } = await import("@mysten-incubation/memwal");
    const client = MemWal.create({ key: cfg.privateKey, accountId: cfg.accountId, serverUrl: relayer.url });

    const h = makeApi();
    registerHooks(h.api, client, cfg);
    const out = await h.hooks["before_prompt_build"]({ prompt: "what do I prefer for backend?" }, {});

    assert.ok(out?.appendSystemContext, "namespace instruction must survive a 429");
    assert.ok(!out?.prependContext);
    assert.ok(h.logs.some((l) => /failed/.test(l)), `expected a failure log, got ${JSON.stringify(h.logs)}`);
  } finally {
    await relayer.close();
  }
});

test("429 on capture retries within budget and does not throw", async () => {
  const relayer = await startMockRelayer("429");
  try {
    const cfg = parseConfig({ ...CREDS, serverUrl: relayer.url, requestTimeoutMs: 5000 });
    const { MemWal } = await import("@mysten-incubation/memwal");
    const client = MemWal.create({ key: cfg.privateKey, accountId: cfg.accountId, serverUrl: relayer.url });

    const h = makeApi();
    registerHooks(h.api, client, cfg);
    await h.hooks["agent_end"](
      { success: true, messages: [{ role: "user", content: GOOD_TURN }] },
      {},
    );
    // One retry means two attempts, never an unbounded loop against a
    // rate-limited relayer.
    assert.equal(relayer.hits.length, 2, `expected 2 attempts, saw ${relayer.hits.length}`);
  } finally {
    await relayer.close();
  }
});

test("500 degrades instead of breaking the turn", async () => {
  const relayer = await startMockRelayer("500");
  try {
    const cfg = parseConfig({ ...CREDS, serverUrl: relayer.url, requestTimeoutMs: 5000 });
    const { MemWal } = await import("@mysten-incubation/memwal");
    const client = MemWal.create({ key: cfg.privateKey, accountId: cfg.accountId, serverUrl: relayer.url });

    const h = makeApi();
    registerHooks(h.api, client, cfg);
    const out = await h.hooks["before_prompt_build"]({ prompt: "what do I prefer for backend?" }, {});
    assert.ok(out?.appendSystemContext);
    assert.ok(!out?.prependContext);
  } finally {
    await relayer.close();
  }
});

test("a relayer that never replies is cut off by the deadline", async () => {
  // The regression this whole deadline exists for. Before it, the hook stayed
  // pending indefinitely and the agent turn never completed.
  const relayer = await startMockRelayer("hang");
  try {
    const cfg = parseConfig({ ...CREDS, serverUrl: relayer.url, requestTimeoutMs: 1500 });
    const { MemWal } = await import("@mysten-incubation/memwal");
    const client = MemWal.create({ key: cfg.privateKey, accountId: cfg.accountId, serverUrl: relayer.url });

    const h = makeApi();
    registerHooks(h.api, client, cfg);

    const started = Date.now();
    const out = await h.hooks["before_prompt_build"]({ prompt: "what do I prefer for backend?" }, {});
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 10_000, `took ${elapsed}ms, deadline did not fire`);
    assert.ok(out?.appendSystemContext, "namespace instruction must survive a timeout");
    assert.ok(
      h.logs.some((l) => /timed out/.test(l)),
      `expected a timeout log, got ${JSON.stringify(h.logs)}`,
    );
  } finally {
    await relayer.close();
  }
});
