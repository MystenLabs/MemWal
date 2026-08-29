import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

function isMappedIpv4(bytes: number[]): boolean {
  return (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  );
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

    return bytes
      ? BLOCKED_V4_RANGES.some(([network, prefix]) =>
          withinRange(bytes, ipv4ToBytes(network) as number[], prefix)
        )
      : true;
  }

  if (version === 6) {
    const bytes = ipv6ToBytes(address);

    if (!bytes) {
      return true;
    }
    if (isMappedIpv4(bytes)) {
      return BLOCKED_V4_RANGES.some(([network, prefix]) =>
        withinRange(bytes.slice(12), ipv4ToBytes(network) as number[], prefix)
      );
    }

    return BLOCKED_V6_RANGES.some(([network, prefix]) =>
      withinRange(bytes, ipv6ToBytes(network) as number[], prefix)
    );
  }

  return true;
}

/**
 * Parse a user-supplied URL and confirm it names a public HTTP(S) destination.
 * Hostnames are resolved and every returned address has to be public, so a name
 * pointing at 127.0.0.1 is rejected as surely as the literal is.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
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

    return url;
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

  return url;
}

/**
 * fetch for user-supplied URLs, with the destination checked before the request
 * leaves and again at every redirect. Redirects are followed by hand because
 * fetch's own following would skip the check on each new target.
 *
 * A host that answers with a public address and then a private one on the next
 * resolution (DNS rebinding) is not covered; that needs the connection pinned to
 * the address that was checked, which fetch does not expose.
 */
export async function fetchPublicUrl(
  rawUrl: string,
  init?: RequestInit
): Promise<Response> {
  let target = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(target);
    const response = await fetch(url, { ...init, redirect: "manual" });
    const location = response.headers.get("location");

    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }

    target = new URL(location, url).toString();
  }

  throw new ChatbotError(
    "bad_request:api",
    "Too many redirects while fetching the URL"
  );
}
