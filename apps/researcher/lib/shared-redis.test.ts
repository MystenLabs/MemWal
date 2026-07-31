import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

test("Enoki challenge returns 503 promptly when Redis is unreachable", async () => {
  const port = await closedLoopbackPort();
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.AUTH_SECRET = "01234567890123456789012345678901";

  const { POST } = await import("../app/api/auth/enoki/challenge/route");
  const request = new Request("http://localhost/api/auth/enoki/challenge", {
    body: JSON.stringify({
      suiAddress:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "x-real-ip": "192.0.2.10",
    },
    method: "POST",
  });

  const started = performance.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const response = await Promise.race([
    POST(request),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("route did not fail closed in time")),
        5000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  const elapsedMs = performance.now() - started;

  assert.equal(response.status, 503);
  assert(elapsedMs < 5000, `expected finite 503, took ${elapsedMs}ms`);
});
