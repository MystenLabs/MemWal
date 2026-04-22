#!/usr/bin/env npx tsx
/**
 * bench-walrus-concurrency.ts — ENG-1409
 *
 * Concurrent load-tester for the Walrus upload-relay path.
 *
 * Tests upload throughput, p50/p95/p99 latency, and failure rate across
 * increasing concurrency levels to find the safe upper bound for the
 * sidecar upload path (Walrus relay + Enoki sponsorship).
 *
 * Usage:
 *   npx tsx bench-walrus-concurrency.ts \
 *     --sidecar-url  http://localhost:9000 \
 *     --sidecar-token <SIDECAR_AUTH_TOKEN> \
 *     --key-index    0 \
 *     --owner        0x<64-hex-chars> \
 *     --blob-kb      16 \
 *     --concurrency-levels 1,2,3,5 \
 *     --requests-per-level 8 \
 *     --output bench-results.json
 *
 * Each concurrency level runs `--requests-per-level` requests through a
 * pool of that width, then waits for all to finish before moving on.
 *
 * Flags:
 *   --sidecar-url           URL of the running sidecar server (default: http://localhost:9000)
 *   --sidecar-token         SIDECAR_AUTH_TOKEN shared secret
 *   --key-index             Sidecar key-pool index to use (default: 0)
 *   --owner                 Sui address that will receive the Blob object (0x + 64 hex)
 *   --blob-kb               Payload size per upload in KiB (default: 16)
 *   --concurrency-levels    Comma-separated list of concurrency widths to try (default: 1,2,3,5)
 *   --requests-per-level    Total uploads at each concurrency level (default: 8)
 *   --output                Path to write JSON results file (default: bench-results.json)
 *   --no-color              Disable ANSI color in output
 *   --help                  Print usage and exit
 *
 * Output:
 *   • ANSI table to stdout with latency percentiles and failure rate per level
 *   • JSON file at --output with raw per-request timings
 */

// ============================================================
// CLI
// ============================================================

interface Args {
    sidecarUrl: string;
    sidecarToken: string;
    keyIndex: number;
    owner: string;
    blobKb: number;
    concurrencyLevels: number[];
    requestsPerLevel: number;
    output: string;
    color: boolean;
}

function printHelp(): void {
    console.log(`
bench-walrus-concurrency.ts — ENG-1409: Walrus upload concurrency benchmark

Usage:
  npx tsx bench-walrus-concurrency.ts [options]

Options:
  --sidecar-url <url>               Sidecar HTTP URL          [default: http://localhost:9000]
  --sidecar-token <token>           SIDECAR_AUTH_TOKEN        [required]
  --key-index <n>                   Sidecar key-pool index    [default: 0]
  --owner <0x...>                   Sui owner address         [required]
  --blob-kb <n>                     Upload size in KiB        [default: 16]
  --concurrency-levels <1,2,3,5>    Concurrency levels        [default: 1,2,3,5]
  --requests-per-level <n>          Requests per level        [default: 8]
  --output <file>                   JSON output path          [default: bench-results.json]
  --no-color                        Disable ANSI colors
  --help                            Show this help
`);
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        printHelp();
        process.exit(0);
    }

    const get = (flag: string, def?: string): string | undefined => {
        const idx = argv.indexOf(flag);
        if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
        return def;
    };

    const sidecarToken = get("--sidecar-token") ?? process.env.SIDECAR_AUTH_TOKEN ?? "";
    const owner = get("--owner") ?? process.env.BENCH_OWNER ?? "";

    if (!sidecarToken) {
        console.error("error: --sidecar-token (or SIDECAR_AUTH_TOKEN env var) is required");
        process.exit(1);
    }
    if (!owner) {
        console.error("error: --owner (or BENCH_OWNER env var) is required (0x + 64 hex chars)");
        process.exit(1);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(owner)) {
        console.error(`error: --owner must be 0x + 64 hex chars, got: ${owner}`);
        process.exit(1);
    }

    const levelsRaw = get("--concurrency-levels", "1,2,3,5")!;
    const concurrencyLevels = levelsRaw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0)
        .sort((a, b) => a - b);

    if (concurrencyLevels.length === 0) {
        console.error("error: --concurrency-levels must be a non-empty comma-separated list of positive integers");
        process.exit(1);
    }

    return {
        sidecarUrl: get("--sidecar-url", "http://localhost:9000")!,
        sidecarToken,
        keyIndex: parseInt(get("--key-index", "0")!, 10),
        owner,
        blobKb: parseInt(get("--blob-kb", "16")!, 10),
        concurrencyLevels,
        requestsPerLevel: parseInt(get("--requests-per-level", "8")!, 10),
        output: get("--output", "bench-results.json")!,
        color: !argv.includes("--no-color"),
    };
}

// ============================================================
// Helpers
// ============================================================

/** Percentile of a sorted array (already sorted ascending). */
function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function ms(n: number): string {
    return `${n.toFixed(0)} ms`;
}

// ANSI helpers
const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
};

function color(enabled: boolean, code: string, s: string): string {
    return enabled ? `${code}${s}${C.reset}` : s;
}

/** Generate a random Uint8Array of exactly `bytes` length. */
function randomBlob(bytes: number): Uint8Array {
    const buf = new Uint8Array(bytes);
    // Fill with pseudo-random bytes (crypto.getRandomValues limited to 65536 at a time)
    for (let offset = 0; offset < bytes; offset += 65536) {
        crypto.getRandomValues(buf.subarray(offset, Math.min(offset + 65536, bytes)));
    }
    return buf;
}

/** Encode Uint8Array to base64 string (Node.js Buffer). */
function toBase64(data: Uint8Array): string {
    return Buffer.from(data).toString("base64");
}

// ============================================================
// Single upload
// ============================================================

interface UploadResult {
    ok: boolean;
    latencyMs: number;
    blobId?: string;
    error?: string;
    statusCode?: number;
}

async function uploadOnce(
    sidecarUrl: string,
    sidecarToken: string,
    keyIndex: number,
    owner: string,
    blob: Uint8Array,
): Promise<UploadResult> {
    const start = performance.now();
    try {
        const resp = await fetch(`${sidecarUrl}/walrus/upload`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${sidecarToken}`,
            },
            body: JSON.stringify({
                data: toBase64(blob),
                keyIndex,
                owner,
                namespace: "bench",
                packageId: null,
                epochs: 1, // minimal storage cost during bench
            }),
        });

        const latencyMs = performance.now() - start;

        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            return { ok: false, latencyMs, statusCode: resp.status, error: body.slice(0, 200) };
        }

        const json = (await resp.json()) as { blobId?: string };
        return { ok: true, latencyMs, blobId: json.blobId };
    } catch (err: any) {
        const latencyMs = performance.now() - start;
        return { ok: false, latencyMs, error: err?.message ?? String(err) };
    }
}

// ============================================================
// Concurrency pool
// ============================================================

/**
 * Run `total` tasks with at most `concurrency` in-flight at a time.
 * Returns results in completion order (not submission order).
 */
async function runPool<T>(
    total: number,
    concurrency: number,
    task: (index: number) => Promise<T>,
): Promise<T[]> {
    const results: T[] = [];
    let next = 0;

    async function worker(): Promise<void> {
        while (true) {
            const idx = next++;
            if (idx >= total) return;
            results.push(await task(idx));
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
    await Promise.all(workers);
    return results;
}

// ============================================================
// Level run
// ============================================================

interface LevelResult {
    concurrency: number;
    requests: number;
    successCount: number;
    failCount: number;
    failureRate: number;
    durationMs: number;
    throughputRps: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    min: number;
    mean: number;
    rawMs: number[];
    errors: string[];
}

async function runLevel(
    args: Args,
    concurrency: number,
    blob: Uint8Array,
): Promise<LevelResult> {
    const total = args.requestsPerLevel;
    const errors: string[] = [];
    const allMs: number[] = [];
    const okMs: number[] = [];

    const wallStart = performance.now();

    const results = await runPool(total, concurrency, () =>
        uploadOnce(args.sidecarUrl, args.sidecarToken, args.keyIndex, args.owner, blob)
    );

    const wallDuration = performance.now() - wallStart;

    let successCount = 0;
    let failCount = 0;

    for (const r of results) {
        allMs.push(r.latencyMs);
        if (r.ok) {
            successCount++;
            okMs.push(r.latencyMs);
        } else {
            failCount++;
            errors.push(r.error ?? `HTTP ${r.statusCode}`);
        }
    }

    const sorted = [...allMs].sort((a, b) => a - b);
    const mean = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

    return {
        concurrency,
        requests: total,
        successCount,
        failCount,
        failureRate: failCount / total,
        durationMs: wallDuration,
        throughputRps: (successCount / wallDuration) * 1000,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1] ?? 0,
        min: sorted[0] ?? 0,
        mean,
        rawMs: sorted,
        errors,
    };
}

// ============================================================
// Reporting
// ============================================================

function printTable(levels: LevelResult[], col: boolean): void {
    const h = (s: string) => color(col, C.bold + C.cyan, s);
    const ok = (s: string) => color(col, C.green, s);
    const warn = (s: string) => color(col, C.yellow, s);
    const err_ = (s: string) => color(col, C.red, s);

    const colW = [12, 10, 10, 10, 10, 10, 12, 10];
    const cols = ["concurrency", "p50", "p95", "p99", "max", "min", "throughput", "fail%"];

    function row(cells: string[]): string {
        return cells.map((c, i) => c.padStart(colW[i])).join("  ");
    }

    console.log();
    console.log(h(row(cols)));
    console.log(color(col, C.dim, row(cols.map((_, i) => "─".repeat(colW[i])))));

    for (const l of levels) {
        const failPct = (l.failureRate * 100).toFixed(1) + "%";
        const tput = l.throughputRps.toFixed(2) + " rps";
        const cells = [
            String(l.concurrency),
            ms(l.p50),
            ms(l.p95),
            ms(l.p99),
            ms(l.max),
            ms(l.min),
            tput,
            failPct,
        ];
        // Color the row based on failure rate and p95:
        const rowStr = row(cells);
        if (l.failureRate >= 0.2) {
            console.log(err_(rowStr));
        } else if (l.failureRate >= 0.1 || l.p95 > 10_000) {
            console.log(warn(rowStr));
        } else {
            console.log(ok(rowStr));
        }
    }
    console.log();
}

function printErrors(levels: LevelResult[], col: boolean): void {
    for (const l of levels) {
        if (l.errors.length === 0) continue;
        console.log(color(col, C.yellow, `\n▶ Errors at concurrency=${l.concurrency}:`));
        const shown = l.errors.slice(0, 5);
        for (const e of shown) console.log(`  • ${e}`);
        if (l.errors.length > 5) {
            console.log(color(col, C.dim, `  … and ${l.errors.length - 5} more`));
        }
    }
}

function buildMarkdownTable(levels: LevelResult[], blobKb: number): string {
    const lines: string[] = [
        `## Walrus Upload Concurrency Benchmark — ${blobKb} KiB blobs`,
        "",
        "| concurrency | requests | success | p50 | p95 | p99 | max | throughput | fail% |",
        "|-------------|----------|---------|-----|-----|-----|-----|------------|-------|",
    ];
    for (const l of levels) {
        lines.push(
            `| ${l.concurrency} | ${l.requests} | ${l.successCount} | ${ms(l.p50)} | ${ms(l.p95)} | ${ms(l.p99)} | ${ms(l.max)} | ${l.throughputRps.toFixed(2)} rps | ${(l.failureRate * 100).toFixed(1)}% |`
        );
    }
    return lines.join("\n");
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
    const args = parseArgs();
    const col = args.color && process.stdout.isTTY;

    const blobBytes = args.blobKb * 1024;
    const blob = randomBlob(blobBytes);

    console.log(color(col, C.bold, "\n⚡ bench-walrus-concurrency — ENG-1409\n"));
    console.log(`  sidecar:            ${args.sidecarUrl}`);
    console.log(`  blob size:          ${args.blobKb} KiB (${blobBytes} bytes)`);
    console.log(`  concurrency levels: ${args.concurrencyLevels.join(", ")}`);
    console.log(`  requests / level:   ${args.requestsPerLevel}`);
    console.log(`  key index:          ${args.keyIndex}`);
    console.log(`  owner:              ${args.owner.slice(0, 10)}...`);
    console.log();

    // Warm-up: one upload at c=1 to prime Enoki/relay connections, not counted in results.
    process.stdout.write(color(col, C.dim, "  warm-up upload..."));
    const warmup = await uploadOnce(args.sidecarUrl, args.sidecarToken, args.keyIndex, args.owner, blob);
    if (warmup.ok) {
        console.log(color(col, C.green, ` ok (${ms(warmup.latencyMs)})`));
    } else {
        console.log(color(col, C.red, ` FAILED: ${warmup.error}`));
        console.error("\nCould not complete warm-up upload. Check sidecar is running and credentials are correct.");
        process.exit(1);
    }

    const levelResults: LevelResult[] = [];

    for (const concurrency of args.concurrencyLevels) {
        process.stdout.write(
            `  concurrency=${color(col, C.bold, String(concurrency))} — running ${args.requestsPerLevel} requests...`
        );
        const result = await runLevel(args, concurrency, blob);
        levelResults.push(result);
        console.log(
            ` done  p50=${ms(result.p50)}  p95=${ms(result.p95)}  fail=${(result.failureRate * 100).toFixed(0)}%`
        );
    }

    // Terminal table
    printTable(levelResults, col);
    printErrors(levelResults, col);

    // Markdown summary
    const md = buildMarkdownTable(levelResults, args.blobKb);
    console.log(md);
    console.log();

    // JSON output
    const jsonOut = {
        timestamp: new Date().toISOString(),
        config: {
            blobKb: args.blobKb,
            requestsPerLevel: args.requestsPerLevel,
            sidecarUrl: args.sidecarUrl,
            keyIndex: args.keyIndex,
        },
        levels: levelResults.map((l) => ({
            concurrency: l.concurrency,
            requests: l.requests,
            successCount: l.successCount,
            failCount: l.failCount,
            failureRate: +l.failureRate.toFixed(4),
            durationMs: +l.durationMs.toFixed(1),
            throughputRps: +l.throughputRps.toFixed(3),
            p50Ms: +l.p50.toFixed(1),
            p95Ms: +l.p95.toFixed(1),
            p99Ms: +l.p99.toFixed(1),
            maxMs: +l.max.toFixed(1),
            minMs: +l.min.toFixed(1),
            meanMs: +l.mean.toFixed(1),
            errors: l.errors,
            rawMs: l.rawMs.map((n) => +n.toFixed(1)),
        })),
        markdownTable: md,
    };

    const { writeFileSync } = await import("fs");
    writeFileSync(args.output, JSON.stringify(jsonOut, null, 2));
    console.log(color(col, C.dim, `  Results written to ${args.output}\n`));

    // Recommendation
    const safeLevel = levelResults
        .filter((l) => l.failureRate < 0.05 && l.p95 < 15_000)
        .reduce<LevelResult | null>((best, l) => (!best || l.concurrency > best.concurrency ? l : best), null);

    if (safeLevel) {
        console.log(
            color(col, C.green, `✔ Safe upper bound: concurrency=${safeLevel.concurrency}`) +
            ` (p95=${ms(safeLevel.p95)}, fail=${(safeLevel.failureRate * 100).toFixed(1)}%)`
        );
    } else {
        console.log(color(col, C.red, "✘ No concurrency level met the safety threshold (<5% failure, p95<15s)."));
        console.log("  Consider using concurrency=1 or checking Enoki/relay quota.");
    }
    console.log();
}

main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFatal error: ${msg}`);
    process.exit(1);
});
