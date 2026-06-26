/**
 * Trustless, local verification of a Walrus Memory (MemWal) blob.
 *
 * Confirms a memory's provenance from PUBLIC INPUTS ONLY — no private key,
 * no relayer. Given a `blobId` and the owning `accountId`, it:
 *
 *   1. resolves the on-chain Walrus `Blob` object on Sui and reads its
 *      `memwal_*` metadata (namespace / owner / package_id / agent_id);
 *   2. checks that `memwal_agent_id` is one of the account's registered
 *      `DelegateKey` public keys (the cryptographic blob <-> account binding);
 *   3. confirms the blob is retrievable from the public Walrus aggregator;
 *   4. (optional, see ALIGN-Q3) recomputes the Walrus content-address from bytes.
 *
 * Everything here is reachable by a third party with no MemWal credentials.
 *
 * `@mysten/sui` is loaded dynamically (mirrors `account.ts`), so this module
 * stays importable from the dependency-light default entry point.
 *
 * NOTE FOR REVIEWERS (ALIGN markers): three spots depend on the exact on-chain
 * schema and are flagged ALIGN-Q1 / ALIGN-Q3. They mirror the open questions in
 * issue #315 and are written defensively; happy to tighten to the canonical
 * layout once confirmed.
 */

export type MemWalNetwork = "testnet" | "mainnet";

const SUI_FULLNODE: Record<MemWalNetwork, string> = {
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
};

const ENDPOINTS: Record<MemWalNetwork, { aggregator: string }> = {
  testnet: { aggregator: "https://aggregator.walrus-testnet.walrus.space" },
  mainnet: { aggregator: "https://aggregator.walrus-mainnet.walrus.space" },
};

const METADATA_KEYS = [
  "memwal_namespace",
  "memwal_owner",
  "memwal_package_id",
  "memwal_agent_id",
] as const;

export interface VerifyOptions {
  /** Owning MemWalAccount object id — used to check the delegate-key binding. */
  accountId?: string;
  /** Network preset for default RPC + aggregator endpoints. Default: "testnet". */
  network?: MemWalNetwork;
  /** Override the Sui JSON-RPC endpoint. */
  suiRpcUrl?: string;
  /** Override the public Walrus aggregator base (e.g. https://aggregator.walrus-testnet.walrus.space). */
  walrusAggregatorUrl?: string;
  /**
   * ALIGN-Q1: optionally short-circuit on-chain resolution by passing the Sui
   * object id of the `Blob` directly. When omitted, we resolve by scanning the
   * account's owned `Blob` objects and matching `blob_id === blobId`.
   */
  objectId?: string;
  /** When supplied, `ownerOk` asserts `memwal_owner === expectedOwner`. */
  expectedOwner?: string;
  /**
   * Inject a pre-built SuiClient. Required for `@mysten/sui` v2.6.0+, where the
   * client constructor moved — same escape hatch the account API uses.
   */
  suiClient?: any;
}

export interface VerifyReport {
  /** Hard checks all passed: onChain && agentKeyOk && walrusReachable (&& ownerOk when expectedOwner given). */
  ok: boolean;
  /** Blob object resolved on Sui and carries memwal_* metadata. */
  onChain: boolean;
  /** memwal_agent_id is one of the account's registered DelegateKey pubkeys. */
  agentKeyOk: boolean;
  /** memwal_owner matches expectedOwner (true when no expectedOwner supplied and metadata present). */
  ownerOk: boolean;
  /** Blob retrievable from the public Walrus aggregator. */
  walrusReachable: boolean;
  /** ALIGN-Q3: recomputed Walrus id matches blobId. `undefined` until the encoding recompute lands. */
  contentAddressed?: boolean;
  /** memwal_namespace from on-chain metadata, if present. */
  namespace?: string;
  /** Raw memwal_* metadata map read from the Blob object. */
  metadata: Record<string, string>;
  /** Resolved Sui object id of the Blob (useful for re-checks / debugging). */
  blobObjectId?: string;
  /** Non-fatal diagnostics (resolution misses, RPC hiccups, etc.). */
  notes: string[];
}

/**
 * Verify a memory's provenance with no relayer and no private key.
 */
export async function verifyMemory(
  blobId: string,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const network = opts.network ?? "testnet";
  const aggregator = (
    opts.walrusAggregatorUrl ?? ENDPOINTS[network].aggregator
  ).replace(/\/$/, "");

  const notes: string[] = [];
  const report: VerifyReport = {
    ok: false,
    onChain: false,
    agentKeyOk: false,
    ownerOk: false,
    walrusReachable: false,
    metadata: {},
    notes,
  };

  const client = await buildSuiClient(opts, network, notes);

  if (client) {
    // ── 1. resolve the on-chain Blob object + memwal_* metadata ────────────
    const blobObjectId = await resolveBlobObjectId(client, blobId, opts, notes);
    if (blobObjectId) {
      report.blobObjectId = blobObjectId;
      const obj = await client.getObject({
        id: blobObjectId,
        options: { showContent: true, showType: true },
      });
      const fields = contentFields(obj.data?.content);
      const metadata = extractMemwalMetadata(fields);
      report.metadata = metadata;
      report.namespace = metadata.memwal_namespace;
      report.onChain = METADATA_KEYS.some((k) => k in metadata);
      if (!report.onChain) {
        notes.push(
          `Blob object ${blobObjectId} resolved but carried no memwal_* metadata — ` +
            `confirm the metadata VecMap path (ALIGN-Q1).`,
        );
      }
    } else {
      notes.push(
        `Could not resolve a Blob object for blobId ${blobId}. Pass opts.objectId ` +
          `to short-circuit, or confirm the account's blob-ownership model (ALIGN-Q1).`,
      );
    }

    // ── 2. delegate-key binding: memwal_agent_id ∈ account's DelegateKeys ───
    const agentId = report.metadata.memwal_agent_id;
    if (opts.accountId && agentId) {
      const pubkeys = await registeredDelegateKeys(client, opts.accountId, notes);
      report.agentKeyOk = pubkeys.has(normalizeHex(agentId));
      if (!report.agentKeyOk && pubkeys.size === 0) {
        notes.push(
          `No DelegateKey pubkeys read from account ${opts.accountId} — confirm where ` +
            `delegate keys live on MemWalAccount (content vector vs dynamic field) (ALIGN-Q1).`,
        );
      }
    } else if (!opts.accountId) {
      notes.push("agentKeyOk skipped: pass opts.accountId to check the delegate-key binding.");
    }
  } else {
    notes.push(
      "On-chain checks skipped: no SuiClient available. Install @mysten/sui, or pass " +
        "opts.suiClient for v2.6.0+. Walrus retrievability is still checked below.",
    );
  }

  // ── 3. owner check ─────────────────────────────────────────────────────
  if (opts.expectedOwner) {
    report.ownerOk =
      normalizeHex(report.metadata.memwal_owner ?? "") === normalizeHex(opts.expectedOwner);
  } else {
    report.ownerOk = Boolean(report.metadata.memwal_owner);
  }

  // ── 4. relayer-independent retrievability from public Walrus aggregator ─
  const dl = await fetchBlob(aggregator, blobId, notes);
  report.walrusReachable = dl.ok;

  // ── (ALIGN-Q3) content-address recompute — deferred until the encoding dep lands.
  // report.contentAddressed = recomputeWalrusId(dl.bytes) === blobId;

  report.ok =
    report.onChain &&
    report.agentKeyOk &&
    report.walrusReachable &&
    (opts.expectedOwner ? report.ownerOk : true);

  return report;
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Build a SuiClient via the dynamic-import convention used across the SDK. */
async function buildSuiClient(
  opts: VerifyOptions,
  network: MemWalNetwork,
  notes: string[],
): Promise<any | undefined> {
  if (opts.suiClient) return opts.suiClient;
  try {
    const mod = await import("@mysten/sui/client");
    const SuiClient = (mod as any).SuiClient;
    if (typeof SuiClient !== "function") {
      notes.push("SuiClient not found. For @mysten/sui v2.6.0+, pass opts.suiClient.");
      return undefined;
    }
    return new SuiClient({ url: opts.suiRpcUrl ?? SUI_FULLNODE[network] });
  } catch (e) {
    notes.push(`Could not load @mysten/sui/client: ${(e as Error).message}`);
    return undefined;
  }
}

/** ALIGN-Q1: resolve a Walrus blobId to its Sui Blob object id. */
async function resolveBlobObjectId(
  client: any,
  blobId: string,
  opts: VerifyOptions,
  notes: string[],
): Promise<string | undefined> {
  if (opts.objectId) return opts.objectId;
  if (!opts.accountId) {
    notes.push("Blob resolution needs opts.accountId or opts.objectId.");
    return undefined;
  }
  // Scan objects owned by the account address for a Blob whose blob_id matches.
  // (The PoC matched against the delegate `owner`; the account may also own the
  //  Blob, or it may hang off a dynamic field — hence ALIGN-Q1.)
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const owned: any = await client.getOwnedObjects({
      owner: opts.accountId,
      options: { showType: true, showContent: true },
      cursor,
      limit: 50,
    });
    for (const o of owned.data) {
      const type = o.data?.type ?? "";
      if (!type.includes("::blob::Blob")) continue;
      const f = contentFields(o.data?.content);
      const onChainBlobId = String(f?.blob_id ?? f?.blobId ?? "");
      if (onChainBlobId && onChainBlobId === blobId) return o.data?.objectId;
    }
    if (!owned.hasNextPage) break;
    cursor = owned.nextCursor ?? null;
  }
  return undefined;
}

/** ALIGN-Q1: read the account's registered DelegateKey public keys. */
async function registeredDelegateKeys(
  client: any,
  accountId: string,
  notes: string[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const acc = await client.getObject({
      id: accountId,
      options: { showContent: true },
    });
    const fields = contentFields(acc.data?.content);
    // Look for a vector/table of delegate keys in the account content.
    collectPubkeys(fields, keys);

    // Also sweep dynamic fields, where registries commonly live.
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const dyn: any = await client.getDynamicFields({ parentId: accountId, cursor, limit: 50 });
      for (const d of dyn.data) {
        try {
          const dfo = await client.getDynamicFieldObject({ parentId: accountId, name: d.name });
          collectPubkeys(contentFields(dfo.data?.content), keys);
        } catch {
          /* best-effort */
        }
      }
      if (!dyn.hasNextPage) break;
      cursor = dyn.nextCursor ?? null;
    }
  } catch (e) {
    notes.push(`registeredDelegateKeys: ${(e as Error).message}`);
  }
  return keys;
}

/** Recursively pull anything that looks like a delegate public key into `out`. */
function collectPubkeys(node: unknown, out: Set<string>): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const v of node) collectPubkeys(v, out);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (/public_key|publicKey|pubkey/i.test(k) && (typeof v === "string" || Array.isArray(v))) {
        out.add(normalizeHex(bytesToHex(v)));
      }
      collectPubkeys(v, out);
    }
  }
}

/** Extract memwal_* keys from a Blob object's Metadata VecMap<String,String>. */
function extractMemwalMetadata(fields: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fields) return out;
  // Metadata is nested: blob.metadata -> Metadata -> metadata (VecMap) -> contents[]
  const meta = (fields.metadata as any)?.fields?.metadata?.fields?.contents
    ?? (fields.metadata as any)?.fields?.contents
    ?? (fields.metadata as any)?.contents;
  if (Array.isArray(meta)) {
    for (const entry of meta) {
      const key = entry?.fields?.key ?? entry?.key;
      const value = entry?.fields?.value ?? entry?.value;
      if (typeof key === "string" && key.startsWith("memwal_")) out[key] = String(value);
    }
  }
  return out;
}

async function fetchBlob(
  aggregator: string,
  blobId: string,
  notes: string[],
): Promise<{ ok: boolean; status?: number; bytes?: Uint8Array }> {
  // The aggregator has used both /v1/blobs/{id} and /v1/{id}; try both.
  for (const path of [`/v1/blobs/${blobId}`, `/v1/${blobId}`]) {
    try {
      const res = await fetch(aggregator + path);
      if (res.ok) {
        return { ok: true, status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
      }
      notes.push(`aggregator ${path} -> ${res.status}`);
    } catch (e) {
      notes.push(`aggregator ${path} -> ${(e as Error).message}`);
    }
  }
  return { ok: false };
}

function contentFields(content: unknown): Record<string, unknown> | undefined {
  if (content && typeof content === "object" && "fields" in (content as any)) {
    return (content as any).fields as Record<string, unknown>;
  }
  return undefined;
}

function bytesToHex(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return "0x" + v.map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return "";
}

function normalizeHex(s: string): string {
  return s.toLowerCase().replace(/^0x/, "");
}
