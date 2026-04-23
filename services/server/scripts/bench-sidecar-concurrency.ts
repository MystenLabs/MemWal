#!/usr/bin/env npx tsx
/**
 * bench-sidecar-concurrency.ts — ENG-1405
 *
 * Concurrent stress-tester cho sidecar HTTP server.
 * Bắn N requests đồng thời vào từng endpoint để tìm giới hạn safe concurrency:
 *
 *   Mode: seal-encrypt   → POST /seal/encrypt      (no Sui RPC, pure crypto)
 *   Mode: seal-decrypt   → POST /seal/decrypt       (SessionKey + Sui RPC + fetchKeys per req)
 *   Mode: decrypt-batch  → POST /seal/decrypt-batch (1 SessionKey cho nhiều items)
 *
 * Chạy qua nhiều concurrency levels (ví dụ: 1,5,10,20,50,100) để thấy
 * latency tăng/cliff và failure rate khi Sui RPC bị throttle.
 *
 * Usage:
 *   npx tsx bench-sidecar-concurrency.ts \
 *     --sidecar-url     http://localhost:9000 \
 *     --sidecar-token   <SIDECAR_AUTH_TOKEN> \
 *     --mode            seal-encrypt \
 *     --concurrency-levels 1,5,10,20 \
 *     --requests-per-level 20 \
 *     --output          bench-sidecar.json
 *
 *   # Test decrypt (cần thêm real ciphertext):
 *   npx tsx bench-sidecar-concurrency.ts \
 *     --mode            seal-decrypt \
 *     --ciphertext-b64  <base64-of-real-SEAL-blob> \
 *     --delegate-key    <suiprivkey1... hoặc 64-hex> \
 *     --package-id      0x... \
 *     --account-id      0x... \
 *     --concurrency-levels 1,5,10,20,50 \
 *     --requests-per-level 10
 *
 *   # Test decrypt-batch (1 SessionKey cho nhiều blobs):
 *   npx tsx bench-sidecar-concurrency.ts \
 *     --mode            decrypt-batch \
 *     --ciphertext-b64  <base64> \
 *     --batch-size      5 \
 *     ...
 *
 * Flags:
 *   --sidecar-url           Sidecar HTTP URL              [default: http://localhost:9000]
 *   --sidecar-token         SIDECAR_AUTH_TOKEN            [required]
 *   --mode                  seal-encrypt|seal-decrypt|decrypt-batch  [default: seal-encrypt]
 *   --concurrency-levels    Comma-separated concurrency widths       [default: 1,5,10,20]
 *   --requests-per-level    Requests per concurrency level           [default: 20]
 *   --output                JSON output path              [default: bench-sidecar.json]
 *   --no-color              Disable ANSI colors
 *
 *   # seal-encrypt options:
 *   --owner                 Sui owner address (0x + 64 hex)  [required for encrypt]
 *   --package-id            MEMWAL_PACKAGE_ID                [required for encrypt]
 *   --plaintext-kb          Plaintext size in KiB            [default: 1]
 *
 *   # seal-decrypt / decrypt-batch options:
 *   --ciphertext-b64        Base64-encoded SEAL ciphertext   [required for decrypt]
 *   --delegate-key          suiprivkey1... or 64-hex         [required for decrypt]
 *   --package-id            MEMWAL_PACKAGE_ID                [required for decrypt]
 *   --account-id            MemWalAccount object ID          [required for decrypt]
 *   --batch-size            Items per decrypt-batch call     [default: 5]
 */

// ============================================================
// CLI
// ============================================================

type Mode = "seal-encrypt" | "seal-decrypt" | "decrypt-batch";

interface Args {
    sidecarUrl: string;
    sidecarToken: string;
    mode: Mode;
    concurrencyLevels: number[];
    requestsPerLevel: number;
    output: string;
    color: boolean;
    // seal-encrypt
    owner: string;
    packageId: string;
    plaintextKb: number;
    // seal-decrypt / decrypt-batch
    ciphertextB64: string;
    delegateKey: string;
    accountId: string;
    batchSize: number;
    skipWarmup: boolean;
}

function printHelp(): void {
    console.log(`
bench-sidecar-concurrency.ts — ENG-1405: Sidecar concurrency stress test

Usage:
  npx tsx bench-sidecar-concurrency.ts [options]

  --sidecar-url <url>             [default: http://localhost:9000]
  --sidecar-token <token>         SIDECAR_AUTH_TOKEN (required)
  --mode <mode>                   seal-encrypt | seal-decrypt | decrypt-batch [default: seal-encrypt]
  --concurrency-levels <1,5,10>   Concurrency widths to sweep [default: 1,5,10,20]
  --requests-per-level <n>        Requests fired at each level [default: 20]
  --output <file>                 JSON results path [default: bench-sidecar.json]
  --no-color                      Disable ANSI colors

  [seal-encrypt options]
  --owner <0x...>                 Sui address (0x + 64 hex)
  --package-id <0x...>            MEMWAL_PACKAGE_ID
  --plaintext-kb <n>              Payload size in KiB [default: 1]

  [seal-decrypt / decrypt-batch options]
  --ciphertext-b64 <base64>       Base64-encoded SEAL ciphertext (use a real blob)
  --delegate-key <key>            suiprivkey1... or 64-char hex
  --package-id <0x...>            MEMWAL_PACKAGE_ID
  --account-id <0x...>            MemWalAccount object ID
  --batch-size <n>                Items per decrypt-batch call [default: 5]

Examples:
  # Fastest: test encrypt (no Sui RPC)
  npx tsx bench-sidecar-concurrency.ts \\
    --sidecar-token $SIDECAR_AUTH_TOKEN \\
    --mode seal-encrypt \\
    --owner 0x$(cat ~/.sui/owner_hex) \\
    --package-id $MEMWAL_PACKAGE_ID \\
    --concurrency-levels 1,5,10,20,50,100

  # Test decrypt (Sui RPC + SEAL key servers)
  npx tsx bench-sidecar-concurrency.ts \\
    --sidecar-token $SIDECAR_AUTH_TOKEN \\
    --mode seal-decrypt \\
    --ciphertext-b64 $CIPHERTEXT \\
    --delegate-key $DELEGATE_KEY \\
    --package-id $MEMWAL_PACKAGE_ID \\
    --account-id $ACCOUNT_ID \\
    --concurrency-levels 1,5,10,20,50 \\
    --requests-per-level 10
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
    if (!sidecarToken) {
        console.error("error: --sidecar-token (or SIDECAR_AUTH_TOKEN env var) is required");
        process.exit(1);
    }

    const modeRaw = get("--mode", "seal-encrypt")! as Mode;
    if (!["seal-encrypt", "seal-decrypt", "decrypt-batch"].includes(modeRaw)) {
        console.error(`error: --mode must be one of: seal-encrypt, seal-decrypt, decrypt-batch`);
        process.exit(1);
    }

    const levelsRaw = get("--concurrency-levels", "1,5,10,20")!;
    const concurrencyLevels = levelsRaw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0)
        .sort((a, b) => a - b);

    if (concurrencyLevels.length === 0) {
        console.error("error: --concurrency-levels must be non-empty comma-separated positive integers");
        process.exit(1);
    }

    return {
        sidecarUrl: get("--sidecar-url", "http://localhost:9000")!,
        sidecarToken,
        mode: modeRaw,
        concurrencyLevels,
        requestsPerLevel: parseInt(get("--requests-per-level", "20")!, 10),
        output: get("--output", "bench-sidecar.json")!,
        color: !argv.includes("--no-color"),
        // encrypt
        owner: get("--owner") ?? process.env.BENCH_OWNER ?? "",
        packageId: get("--package-id") ?? process.env.MEMWAL_PACKAGE_ID ?? "",
        plaintextKb: parseInt(get("--plaintext-kb", "1")!, 10),
        // decrypt
        ciphertextB64: get("--ciphertext-b64") ?? process.env.BENCH_CIPHERTEXT ?? "",
        delegateKey: get("--delegate-key") ?? process.env.BENCH_DELEGATE_KEY ?? "",
        accountId: get("--account-id") ?? process.env.BENCH_ACCOUNT_ID ?? "",
        batchSize: parseInt(get("--batch-size", "5")!, 10),
        skipWarmup: argv.includes("--skip-warmup"),
    };
}

// ============================================================
// ANSI Helpers
// ============================================================

const C = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
    green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
    cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
};
function col(enabled: boolean, code: string, s: string): string {
    return enabled ? `${code}${s}${C.reset}` : s;
}

// ============================================================
// Stats
// ============================================================

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
function ms(n: number): string { return `${n.toFixed(0)}ms`; }

// ============================================================
// Single request implementations
// ============================================================

interface SingleResult {
    ok: boolean;
    latencyMs: number;
    statusCode?: number;
    error?: string;
}

/** POST /seal/encrypt */
async function encryptOnce(args: Args): Promise<SingleResult> {
    const start = performance.now();
    try {
        const plaintext = Buffer.alloc(args.plaintextKb * 1024, 0x41); // fill with 'A'
        const resp = await fetch(`${args.sidecarUrl}/seal/encrypt`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${args.sidecarToken}`,
            },
            body: JSON.stringify({
                data: plaintext.toString("base64"),
                owner: args.owner,
                packageId: args.packageId,
            }),
        });
        const latencyMs = performance.now() - start;
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            return { ok: false, latencyMs, statusCode: resp.status, error: body.slice(0, 200) };
        }
        await resp.json(); // consume body
        return { ok: true, latencyMs, statusCode: resp.status };
    } catch (err: any) {
        return { ok: false, latencyMs: performance.now() - start, error: err?.message ?? String(err) };
    }
}

/** POST /seal/decrypt */
async function decryptOnce(args: Args): Promise<SingleResult> {
    const start = performance.now();
    try {
        const resp = await fetch(`${args.sidecarUrl}/seal/decrypt`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${args.sidecarToken}`,
                "x-delegate-key": args.delegateKey,
            },
            body: JSON.stringify({
                data: args.ciphertextB64,
                packageId: args.packageId,
                accountId: args.accountId,
            }),
        });
        const latencyMs = performance.now() - start;
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            return { ok: false, latencyMs, statusCode: resp.status, error: body.slice(0, 200) };
        }
        await resp.json();
        return { ok: true, latencyMs, statusCode: resp.status };
    } catch (err: any) {
        return { ok: false, latencyMs: performance.now() - start, error: err?.message ?? String(err) };
    }
}

/** POST /seal/decrypt-batch (batchSize copies of same ciphertext) */
async function decryptBatchOnce(args: Args): Promise<SingleResult> {
    const start = performance.now();
    try {
        const items = Array(args.batchSize).fill(args.ciphertextB64);
        const resp = await fetch(`${args.sidecarUrl}/seal/decrypt-batch`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${args.sidecarToken}`,
                "x-delegate-key": args.delegateKey,
            },
            body: JSON.stringify({
                items,
                packageId: args.packageId,
                accountId: args.accountId,
            }),
        });
        const latencyMs = performance.now() - start;
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            return { ok: false, latencyMs, statusCode: resp.status, error: body.slice(0, 200) };
        }
        await resp.json();
        return { ok: true, latencyMs, statusCode: resp.status };
    } catch (err: any) {
        return { ok: false, latencyMs: performance.now() - start, error: err?.message ?? String(err) };
    }
}

function makeRequest(args: Args): () => Promise<SingleResult> {
    switch (args.mode) {
        case "seal-encrypt":   return () => encryptOnce(args);
        case "seal-decrypt":   return () => decryptOnce(args);
        case "decrypt-batch":  return () => decryptBatchOnce(args);
    }
}

// ============================================================
// Concurrency pool (same as bench-walrus-concurrency.ts)
// ============================================================

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
    p50: number; p95: number; p99: number;
    max: number; min: number; mean: number;
    rawMs: number[];
    errorSummary: Record<string, number>; // error message → count
}

async function runLevel(args: Args, concurrency: number): Promise<LevelResult> {
    const total = args.requestsPerLevel;
    const allMs: number[] = [];
    const errorCounts: Record<string, number> = {};
    let successCount = 0;
    let failCount = 0;
    const request = makeRequest(args);
    const wallStart = performance.now();

    const results = await runPool(total, concurrency, () => request());
    const wallDuration = performance.now() - wallStart;

    for (const r of results) {
        allMs.push(r.latencyMs);
        if (r.ok) {
            successCount++;
        } else {
            failCount++;
            // Normalize error key for grouping
            const key = r.error
                ? r.error.replace(/\d{3}/g, "N").slice(0, 80)  // collapse HTTP codes
                : `HTTP ${r.statusCode}`;
            errorCounts[key] = (errorCounts[key] ?? 0) + 1;
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
        errorSummary: errorCounts,
    };
}

// ============================================================
// Reporting
// ============================================================

function printTable(levels: LevelResult[], useColor: boolean): void {
    const h  = (s: string) => col(useColor, C.bold + C.cyan, s);
    const ok = (s: string) => col(useColor, C.green, s);
    const warn = (s: string) => col(useColor, C.yellow, s);
    const err = (s: string) => col(useColor, C.red, s);

    const colW = [12, 10, 10, 10, 10, 10, 12, 10];
    const headers = ["concurrency", "p50", "p95", "p99", "max", "mean", "throughput", "fail%"];

    function row(cells: string[]): string {
        return cells.map((c, i) => c.padStart(colW[i])).join("  ");
    }

    console.log();
    console.log(h(row(headers)));
    console.log(col(useColor, C.dim, row(headers.map((_, i) => "─".repeat(colW[i])))));

    for (const l of levels) {
        const failPct = (l.failureRate * 100).toFixed(1) + "%";
        const tput = l.throughputRps.toFixed(2) + " rps";
        const cells = [
            String(l.concurrency),
            ms(l.p50), ms(l.p95), ms(l.p99), ms(l.max), ms(l.mean),
            tput, failPct,
        ];
        const rowStr = row(cells);
        if (l.failureRate >= 0.2) console.log(err(rowStr));
        else if (l.failureRate >= 0.05 || l.p95 > 5000) console.log(warn(rowStr));
        else console.log(ok(rowStr));
    }
    console.log();
}

function printErrorSummary(levels: LevelResult[], useColor: boolean): void {
    for (const l of levels) {
        if (Object.keys(l.errorSummary).length === 0) continue;
        console.log(col(useColor, C.yellow, `\n▶ Errors at concurrency=${l.concurrency}:`));
        for (const [msg, count] of Object.entries(l.errorSummary)) {
            console.log(`  [×${count}] ${msg}`);
        }
    }
}

function buildMarkdown(levels: LevelResult[], mode: Mode): string {
    const lines = [
        `## Sidecar Concurrency Benchmark — mode=${mode}`,
        "",
        "| concurrency | p50 | p95 | p99 | max | mean | rps | fail% |",
        "|-------------|-----|-----|-----|-----|------|-----|-------|",
    ];
    for (const l of levels) {
        lines.push(
            `| ${l.concurrency} | ${ms(l.p50)} | ${ms(l.p95)} | ${ms(l.p99)} | ${ms(l.max)} | ${ms(l.mean)} | ${l.throughputRps.toFixed(2)} | ${(l.failureRate * 100).toFixed(1)}% |`
        );
    }
    return lines.join("\n");
}

// ============================================================
// Validation helpers
// ============================================================

function validateEncryptArgs(args: Args): void {
    if (!args.owner || !/^0x[0-9a-fA-F]{64}$/.test(args.owner)) {
        console.error("error: --owner must be 0x + 64 hex chars (use BENCH_OWNER env var)");
        process.exit(1);
    }
    if (!args.packageId || !/^0x[0-9a-fA-F]{1,64}$/.test(args.packageId)) {
        console.error("error: --package-id must be a valid Sui address (use MEMWAL_PACKAGE_ID env var)");
        process.exit(1);
    }
}

function validateDecryptArgs(args: Args): void {
    if (!args.ciphertextB64) {
        console.error("error: --ciphertext-b64 is required for decrypt modes");
        console.error("  Tip: grab a real blob_id from your DB, download with walrus aggregator, then base64-encode it.");
        process.exit(1);
    }
    if (!args.delegateKey) {
        console.error("error: --delegate-key is required for decrypt modes");
        process.exit(1);
    }
    if (!args.packageId) {
        console.error("error: --package-id is required for decrypt modes");
        process.exit(1);
    }
    if (!args.accountId) {
        console.error("error: --account-id is required for decrypt modes (MemWalAccount object ID)");
        process.exit(1);
    }
    // Quick size sanity check
    try {
        const bytes = Buffer.from(args.ciphertextB64, "base64");
        if (bytes.length < 32) {
            console.warn(`warning: ciphertext is only ${bytes.length} bytes — may not be a valid SEAL blob`);
        }
    } catch {
        console.error("error: --ciphertext-b64 is not valid base64");
        process.exit(1);
    }
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
    const args = parseArgs();
    const useColor = args.color && process.stdout.isTTY;

    // Validate per-mode args
    if (args.mode === "seal-encrypt") validateEncryptArgs(args);
    else validateDecryptArgs(args);

    console.log(col(useColor, C.bold, `\n⚡ bench-sidecar-concurrency — ENG-1405\n`));
    console.log(`  sidecar:            ${args.sidecarUrl}`);
    console.log(`  mode:               ${col(useColor, C.magenta, args.mode)}`);
    if (args.mode === "seal-encrypt") {
        console.log(`  plaintext size:     ${args.plaintextKb} KiB`);
        console.log(`  owner:              ${args.owner.slice(0, 10)}...`);
    } else {
        const cipherBytes = Buffer.from(args.ciphertextB64, "base64").length;
        console.log(`  ciphertext:         ${cipherBytes} bytes`);
        if (args.mode === "decrypt-batch") {
            console.log(`  batch size:         ${args.batchSize} items per call`);
        }
    }
    console.log(`  concurrency levels: ${args.concurrencyLevels.join(", ")}`);
    console.log(`  requests / level:   ${args.requestsPerLevel}`);
    console.log();

    // ── Health check ─────────────────────────────────────────────────────────
    process.stdout.write(col(useColor, C.dim, "  health check... "));
    try {
        const h = await fetch(`${args.sidecarUrl}/health`, {
            headers: { Authorization: `Bearer ${args.sidecarToken}` },
        });
        if (!h.ok) throw new Error(`HTTP ${h.status}`);
        console.log(col(useColor, C.green, "ok"));
    } catch (e: any) {
        console.log(col(useColor, C.red, `FAILED: ${e.message}`));
        console.error("Cannot reach sidecar. Is it running?");
        process.exit(1);
    }

    // ── Warm-up: 2 serial calls (skip if --skip-warmup) ─────────────────────
    if (!args.skipWarmup) {
        process.stdout.write(col(useColor, C.dim, "  warm-up (2 serial calls)... "));
        const warmReq = makeRequest(args);
        for (let i = 0; i < 2; i++) {
            const r = await warmReq();
            if (!r.ok) {
                console.log(col(useColor, C.red, `FAILED: ${r.error ?? `HTTP ${r.statusCode}`}`));
                console.error("\nWarm-up failed. Re-run with --skip-warmup to bypass, or check credentials.");
                process.exit(1);
            }
        }
        console.log(col(useColor, C.green, "ok"));
    } else {
        console.log(col(useColor, C.yellow, "  warm-up: skipped (--skip-warmup)"));
    }
    console.log();

    // ── Level sweep ──────────────────────────────────────────────────────────
    const levelResults: LevelResult[] = [];

    for (const concurrency of args.concurrencyLevels) {
        process.stdout.write(
            `  concurrency=${col(useColor, C.bold, String(concurrency).padStart(3))}` +
            ` — running ${args.requestsPerLevel} requests...`
        );
        const result = await runLevel(args, concurrency);
        levelResults.push(result);

        const failColor = result.failureRate >= 0.2 ? C.red : result.failureRate >= 0.05 ? C.yellow : C.green;
        console.log(
            ` done` +
            `  p50=${col(useColor, C.cyan, ms(result.p50))}` +
            `  p95=${ms(result.p95)}` +
            `  fail=${col(useColor, failColor, (result.failureRate * 100).toFixed(0) + "%")}`
        );
    }

    // ── Results ───────────────────────────────────────────────────────────────
    printTable(levelResults, useColor);
    printErrorSummary(levelResults, useColor);

    const md = buildMarkdown(levelResults, args.mode);
    console.log(md);
    console.log();

    // ── Verdict ──────────────────────────────────────────────────────────────
    // "Safe" = fail rate < 5% AND p95 < 3s
    const safeLevel = levelResults
        .filter((l) => l.failureRate < 0.05 && l.p95 < 3000)
        .reduce<LevelResult | null>(
            (best, l) => (!best || l.concurrency > best.concurrency ? l : best),
            null
        );

    const firstDanger = levelResults.find((l) => l.failureRate >= 0.05 || l.p95 >= 3000);

    if (safeLevel) {
        console.log(
            col(useColor, C.green, `✔ Safe concurrency upper bound: C=${safeLevel.concurrency}`) +
            `  (p95=${ms(safeLevel.p95)}, fail=${(safeLevel.failureRate * 100).toFixed(1)}%)`
        );
    } else {
        console.log(col(useColor, C.red, "✘ No level passed the safety threshold (<5% fail, p95<3s)"));
    }

    if (firstDanger) {
        console.log(
            col(useColor, C.yellow, `⚠ Degradation starts at concurrency=${firstDanger.concurrency}`) +
            `  (p95=${ms(firstDanger.p95)}, fail=${(firstDanger.failureRate * 100).toFixed(1)}%)`
        );

        if (args.mode === "seal-decrypt" && firstDanger.failureRate > 0) {
            console.log(col(useColor, C.dim,
                "  → Likely Sui RPC rate limit (each /seal/decrypt creates a SessionKey via RPC)"
            ));
            console.log(col(useColor, C.dim,
                "  → Try --mode decrypt-batch to reduce concurrent Sui RPC calls"
            ));
        }
    }

    console.log();

    // ── JSON output ───────────────────────────────────────────────────────────
    const jsonOut = {
        timestamp: new Date().toISOString(),
        config: {
            sidecarUrl: args.sidecarUrl,
            mode: args.mode,
            requestsPerLevel: args.requestsPerLevel,
            plaintextKb: args.mode === "seal-encrypt" ? args.plaintextKb : undefined,
            batchSize: args.mode === "decrypt-batch" ? args.batchSize : undefined,
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
            errorSummary: l.errorSummary,
            rawMs: l.rawMs.map((n) => +n.toFixed(1)),
        })),
        markdownTable: md,
    };

    const { writeFileSync } = await import("fs");
    writeFileSync(args.output, JSON.stringify(jsonOut, null, 2));
    console.log(col(useColor, C.dim, `  Results written to ${args.output}\n`));
}

main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nFatal error: ${msg}`);
    process.exit(1);
});
