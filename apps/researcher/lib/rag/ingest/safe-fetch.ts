import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import { ChatbotError } from "@/lib/errors";

// No "server-only" marker here, matching every other unit-tested module in lib:
// the import throws under `node --test`. The node:dns import above keeps this out
// of a client bundle regardless.

// Outbound fetches for user-supplied source URLs. A file part in a chat request
// names a URL that the server then downloads, so without a destination check the
// request doubles as a probe of whatever the server can reach: loopback services,
// RFC1918 neighbours, and the cloud metadata endpoint on 169.254.169.254.
//
// extractUrlsFromText has a prefix-matching denylist for URLs found in chat text,
// but it only recognises literal 127.0.0.1 and friends at the very start of the
// string. That misses userinfo (http://x@127.0.0.1), IPv6, 127.x outside .0.1,
// hostnames that resolve into a private range, and redirects. This module resolves
// the host and checks every address instead.

const MAX_REDIRECTS = 5;

// [network, prefix length]. Everything a request has no business reaching from a
// URL a user typed: loopback, the private ranges, link-local (which carries the
// metadata service), plus the unspecified, multicast, and reserved blocks.
const BLOCKED_V4_RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const BLOCKED_V6_RANGES: [string, number][] = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  // NAT64 addresses carry an IPv4 destination in their low 32 bits, so they are a
  // way back into the ranges above.
  ["64:ff9b::", 96],
  // IPv4 already blocks 224.0.0.0/4; the v6 multicast range is the counterpart.
  ["ff00::", 8],
];

function ipv4ToBytes(address: string): number[] | null {
  const groups = address.split(".");

  if (groups.length !== 4) {
    return null;
  }

  const bytes = groups.map((group) =>
    /^\d{1,3}$/.test(group) ? Number(group) : Number.NaN
  );

  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

function ipv6GroupsToBytes(part: string): number[] | null {
  if (part === "") {
    return [];
  }

  const groups = part.split(":");
  const bytes: number[] = [];

  for (const [index, group] of groups.entries()) {
    // A trailing dotted-quad (::ffff:127.0.0.1) stands for the last four bytes.
    if (group.includes(".")) {
      const embedded = index === groups.length - 1 ? ipv4ToBytes(group) : null;

      if (!embedded) {
        return null;
      }
      bytes.push(...embedded);
      continue;
    }

    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }
    const value = Number.parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }

  return bytes;
}

function ipv6ToBytes(address: string): number[] | null {
  // Drop any zone id: fe80::1%eth0 addresses the same interface-local target.
  const [plain] = address.split("%");
  const halves = plain.split("::");

  if (halves.length > 2) {
    return null;
  }

  const head = ipv6GroupsToBytes(halves[0]);
  const tail = halves.length === 2 ? ipv6GroupsToBytes(halves[1]) : [];

  if (!head || !tail) {
    return null;
  }

  if (halves.length === 1) {
    return head.length === 16 ? head : null;
  }

  const zeroes = 16 - head.length - tail.length;

  return zeroes < 0
    ? null
    : [...head, ...new Array<number>(zeroes).fill(0), ...tail];
}

function withinRange(
  address: number[],
  network: number[],
  prefixLength: number
): boolean {
  let remaining = prefixLength;

  for (let i = 0; i < address.length && remaining > 0; i++) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;

    if ((address[i] & mask) !== (network[i] & mask)) {
      return false;
    }
    remaining -= bits;
  }

  return true;
}

function isBlockedIpv4Bytes(bytes: number[]): boolean {
  return BLOCKED_V4_RANGES.some(([network, prefix]) =>
    withinRange(bytes, ipv4ToBytes(network) as number[], prefix)
  );
}

function isMappedIpv4(bytes: number[]): boolean {
  return (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  );
}

function isSiitIpv4(bytes: number[]): boolean {
  return (
    bytes.slice(0, 8).every((byte) => byte === 0) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0 &&
    bytes[11] === 0
  );
}

function isIpv4Compatible(bytes: number[]): boolean {
  return bytes.slice(0, 12).every((byte) => byte === 0);
}

/**
 * Whether an IP literal names something outside the public internet. Anything
 * unparseable counts as blocked: a value this code cannot reason about must not
 * be handed to fetch.
 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const bytes = ipv4ToBytes(address);

    return bytes ? isBlockedIpv4Bytes(bytes) : true;
  }

  if (version === 6) {
    const bytes = ipv6ToBytes(address);

    if (!bytes) {
      return true;
    }
    // Mapped, deprecated IPv4-compatible (::/96), and SIIT stash IPv4 in the
    // last 32 bits. Check that payload against the v4 table so ::7f00:1 and
    // ::ffff:0:7f00:1 cannot skip a denylist that already unwraps ::ffff:7f00:1.
    if (isMappedIpv4(bytes) || isSiitIpv4(bytes) || isIpv4Compatible(bytes)) {
      return isBlockedIpv4Bytes(bytes.slice(12));
    }

    return BLOCKED_V6_RANGES.some(([network, prefix]) =>
      withinRange(bytes, ipv6ToBytes(network) as number[], prefix)
    );
  }

  return true;
}

/**
 * A destination that passed validation, together with the addresses it was
 * validated against.
 *
 * The addresses are the point. Validating a hostname and then handing the
 * *name* to an HTTP client means the client resolves it a second time, and
 * nothing requires the second answer to match the first — so the check and the
 * connection can land on different hosts (DNS rebinding). Carrying the
 * validated addresses out of the check lets the connection be pinned to one.
 */
export type PublicDestination = {
  url: URL;
  addresses: string[];
};

/**
 * Parse a user-supplied URL and confirm it names a public HTTP(S) destination.
 * Hostnames are resolved and every returned address has to be public, so a name
 * pointing at 127.0.0.1 is rejected as surely as the literal is.
 */
export async function assertPublicDestination(
  rawUrl: string
): Promise<PublicDestination> {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new ChatbotError("bad_request:api", "Invalid URL format");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ChatbotError(
      "bad_request:api",
      `Unsupported URL scheme: ${url.protocol.replace(":", "")}`
    );
  }

  // URL keeps the brackets on an IPv6 host; isIP does not want them.
  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new ChatbotError(
        "bad_request:api",
        "URL points at a private or reserved address"
      );
    }

    // A literal needs no resolution, so there is no second answer to differ.
    return { url, addresses: [host] };
  }

  let addresses: { address: string }[];

  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new ChatbotError(
      "bad_request:api",
      `Could not resolve host: ${host}`
    );
  }

  if (
    addresses.length === 0 ||
    addresses.some((entry) => isBlockedAddress(entry.address))
  ) {
    throw new ChatbotError(
      "bad_request:api",
      "URL resolves to a private or reserved address"
    );
  }

  return { url, addresses: addresses.map((entry) => entry.address) };
}

/** Back-compat wrapper: the validated URL without the addresses. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const { url } = await assertPublicDestination(rawUrl);
  return url;
}

function headersFromNode(
  raw: NodeJS.Dict<string | string[]>
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    // set-cookie arrives as an array and must stay one header per value.
    for (const entry of Array.isArray(value) ? value : [value]) {
      headers.append(name, entry);
    }
  }
  return headers;
}

/** Statuses the Response constructor refuses to give a body. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/**
 * Perform one request against a *specific* address, while keeping the request
 * addressed to the original host.
 *
 * `fetch` cannot express this: it takes a URL and resolves the name itself. The
 * node client takes the connect address and the TLS identity separately, so we
 * can dial the address that was validated while `Host` and SNI — and therefore
 * certificate verification — stay bound to the hostname the user asked for. An
 * attacker who flips their DNS between the check and the connection now changes
 * nothing, because the second answer is never consulted.
 */
export type PinnedRequestOptions = {
  host: string;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  servername?: string;
  rejectUnauthorized: boolean;
};

/**
 * Build the request options that separate *where we connect* from *who we are
 * talking to*. Exported because this split is the whole fix, and it is worth
 * asserting directly rather than inferring from a live connection.
 */
export function pinnedRequestOptions(
  url: URL,
  address: string,
  init?: RequestInit
): PinnedRequestOptions {
  const secure = url.protocol === "https:";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  const headers = new Headers(init?.headers);
  // Name-based virtual hosts still need to know which site was asked for, and
  // the port belongs here when it is not the default.
  headers.set("host", url.host);

  const outgoing: Record<string, string> = {};
  headers.forEach((value, name) => {
    outgoing[name] = value;
  });

  return {
    // Where the socket actually goes: the validated address, never the name.
    host: address,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: init?.method ?? "GET",
    headers: outgoing,
    // Certificates are checked against the hostname, not the address we
    // dialled — so pinning does not weaken TLS. SNI is meaningless for an IP
    // literal, where the certificate has to carry the address itself.
    ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
    rejectUnauthorized: true,
  };
}

export function fetchPinned(
  url: URL,
  address: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const secure = url.protocol === "https:";
  const send = secure ? httpsRequest : httpRequest;

  return new Promise<Response>((resolve, reject) => {
    const req = send(
      pinnedRequestOptions(url, address, init),
      (res) => {
        const status = res.statusCode ?? 502;
        const body =
          NULL_BODY_STATUS.has(status) || init?.method === "HEAD"
            ? null
            : (Readable.toWeb(res) as ReadableStream<Uint8Array>);

        resolve(
          new Response(body, {
            status,
            statusText: res.statusMessage ?? "",
            headers: headersFromNode(res.headers),
          })
        );
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new ChatbotError("bad_request:api", "Timed out fetching the URL")
      );
    });

    req.on("error", (error) => {
      reject(
        error instanceof ChatbotError
          ? error
          : new ChatbotError(
              "bad_request:api",
              `Could not fetch the URL: ${error.message}`
            )
      );
    });

    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(new ChatbotError("bad_request:api", "Request aborted"));
        return;
      }
      signal.addEventListener("abort", () => req.destroy(), { once: true });
    }

    req.end();
  });
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How one hop is actually sent. Injectable so a test can stage a public first
 * hop without reaching the network — the redirect rules are worth exercising on
 * the real loop, and there is no public address a unit test may dial.
 */
export type PinnedTransport = (
  url: URL,
  address: string,
  init: RequestInit | undefined,
  timeoutMs: number
) => Promise<Response>;

/**
 * fetch for user-supplied URLs, with the destination checked before the request
 * leaves and again at every redirect, and the connection pinned to the address
 * that was checked.
 *
 * Redirects are followed by hand because the client's own following would skip
 * both the check and the pin on each new target — a 302 into 169.254.169.254 is
 * the same attack one hop later.
 */
export async function fetchPublicUrl(
  rawUrl: string,
  init?: RequestInit,
  transport: PinnedTransport = fetchPinned
): Promise<Response> {
  let target = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, addresses } = await assertPublicDestination(target);
    const response = await transport(
      url,
      addresses[0],
      init,
      REQUEST_TIMEOUT_MS
    );
    const location = response.headers.get("location");

    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }

    // The redirect body is of no interest and would otherwise keep streaming.
    await response.body?.cancel().catch(() => {});

    try {
      target = new URL(location, url).toString();
    } catch {
      throw new ChatbotError("bad_request:api", "Invalid URL format");
    }
  }

  throw new ChatbotError(
    "bad_request:api",
    "Too many redirects while fetching the URL"
  );
}
