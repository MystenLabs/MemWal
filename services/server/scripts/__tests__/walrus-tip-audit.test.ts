import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import {
    type DailyBucket,
    bucketKey,
    classifyTx,
    dateStem,
    emitCsv,
    isCliEntrypoint,
    parseWindow,
} from "../walrus-tip-audit.js";
import { SUI_COIN_TYPE, type SuiBalanceChange } from "../walm52-tip-metrics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "..", "walrus-tip-audit.ts");

const POOL = "0x1111111111111111111111111111111111111111111111111111111111111111";
const TIP_A = "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77";
const TIP_B = "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66";
const TIPS: ReadonlySet<string> = new Set([TIP_A, TIP_B].map((a) => a.toLowerCase()));

function change(amount: string, ownerAddr: string, coinType: string = SUI_COIN_TYPE): SuiBalanceChange {
    return { amount, coinType, owner: { AddressOwner: ownerAddr } };
}

test("parseWindow defaults --from to 24h before --to", () => {
    const now = new Date("2026-05-26T12:00:00Z");
    const w = parseWindow(undefined, undefined, now);
    assert.equal(w.toMs, now.getTime());
    assert.equal(w.toMs - w.fromMs, 24 * 60 * 60 * 1000);
});

test("parseWindow honors explicit --from / --to", () => {
    const w = parseWindow("2026-05-24T05:00:00Z", "2026-05-25T05:00:00Z");
    assert.equal(dateStem(w.fromMs), "2026-05-24");
    assert.equal(dateStem(w.toMs), "2026-05-25");
});

test("parseWindow rejects invalid dates and inverted windows", () => {
    assert.throws(() => parseWindow("not-a-date", undefined));
    assert.throws(() => parseWindow(undefined, "not-a-date"));
    assert.throws(() => parseWindow("2026-05-25T00:00:00Z", "2026-05-24T00:00:00Z"));
});

test("classifyTx attributes tip + pool outflow correctly when tip is paid", () => {
    const cls = classifyTx(
        [
            change("-12000000", POOL),       // pool spends 0.012 SUI (tip + dust)
            change("10000000", TIP_A),       // tip A receives 0.010 SUI
            change("2000000", "0xdead"),     // other transfer receives 0.002 SUI
        ],
        POOL,
        TIPS,
    );
    assert.equal(cls.relayTipMist, 10_000_000n);
    assert.equal(cls.poolOutflowMist, 12_000_000n);
    assert.equal(cls.hadRelayTip, true);
});

test("classifyTx records zero tip when no known tip recipient is in balance changes", () => {
    const cls = classifyTx(
        [
            change("-5000000", POOL),
            change("5000000", "0xdead"),
        ],
        POOL,
        TIPS,
    );
    assert.equal(cls.relayTipMist, 0n);
    assert.equal(cls.poolOutflowMist, 5_000_000n);
    assert.equal(cls.hadRelayTip, false);
});

test("classifyTx sums tips across multiple known tip recipients", () => {
    const cls = classifyTx(
        [
            change("-9000000", POOL),
            change("4000000", TIP_A),
            change("5000000", TIP_B),
        ],
        POOL,
        TIPS,
    );
    assert.equal(cls.relayTipMist, 9_000_000n);
    assert.equal(cls.poolOutflowMist, 9_000_000n);
});

test("classifyTx ignores non-SUI coin changes and the wrong sender", () => {
    const cls = classifyTx(
        [
            change("-1000000", "0xnotpool"),               // different sender
            change("1000000", TIP_A, "0x2::wal::WAL"),     // wrong coin
        ],
        POOL,
        TIPS,
    );
    assert.equal(cls.relayTipMist, 0n);
    assert.equal(cls.poolOutflowMist, 0n);
});

test("emitCsv writes header + per-bucket rows with mist/sui/upload count", () => {
    const buckets: DailyBucket[] = [
        { date: "2026-05-25", poolAddress: POOL, relayTipMist: 2_670_000_000n, poolOutflowMist: 2_700_000_000n, uploadCount: 540 },
        { date: "2026-05-24", poolAddress: POOL, relayTipMist: 1_000_000_000n, poolOutflowMist: 1_000_000_000n, uploadCount: 200 },
    ];
    const csv = emitCsv(buckets);
    const lines = csv.trim().split("\n");
    assert.equal(lines[0], "date,pool_address,relay_tip_mist,relay_tip_sui,upload_count_estimate,other_mist");
    // Sorted ascending by date.
    assert.match(lines[1], /^2026-05-24,/);
    assert.match(lines[2], /^2026-05-25,/);
    // SUI conversion (mist / 1e9), 6 dp.
    assert.match(lines[2], /,2\.670000,/);
    // other_mist = pool_outflow - relay_tip.
    assert.match(lines[2], /,30000000$/);
});

test("bucketKey is stable for case variants of the same address", () => {
    assert.equal(
        bucketKey("2026-05-25", POOL.toUpperCase().replace(/^0X/, "0x")),
        bucketKey("2026-05-25", POOL.toLowerCase()),
    );
});

test("isCliEntrypoint matches the URL-encoded form when invoked via tsx with a spaces-in-path argv[1]", () => {
    // Repro the original P1 #2 bug: argv[1] is a raw FS path with spaces;
    // import.meta.url is URL-encoded. Naive `file://${argv[1]}` comparison fails.
    const pathWithSpace = "/tmp/some dir/walrus-tip-audit.ts";
    const argv1 = pathWithSpace;
    const metaUrl = pathToFileURL(pathWithSpace).href;
    assert.equal(isCliEntrypoint(metaUrl, argv1), true);
});

test("isCliEntrypoint returns false when argv[1] points elsewhere", () => {
    const metaUrl = pathToFileURL("/a/walrus-tip-audit.ts").href;
    assert.equal(isCliEntrypoint(metaUrl, "/b/other.ts"), false);
});

test("isCliEntrypoint returns false when argv[1] is missing", () => {
    assert.equal(isCliEntrypoint("file:///irrelevant", undefined), false);
});

test("CLI --help actually fires under tsx and exits 0 with usage text", () => {
    const result = spawnSync("npx", ["tsx", SCRIPT, "--help"], {
        encoding: "utf8",
        timeout: 30_000,
    });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    // Help text is written to stderr (so it doesn't pollute CSV stdout).
    assert.match(result.stderr, /walrus-tip-audit/);
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /--pool-address/);
});

test("CLI errors clearly when required flags are missing", () => {
    const result = spawnSync("npx", ["tsx", SCRIPT], {
        encoding: "utf8",
        timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--pool-address/);
});
