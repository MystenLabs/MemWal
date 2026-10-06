import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    isMoveAbortBalanceSplit,
    isMoveAbortWalDestroyZero,
    refreshWalrusClientOnStaleWalPrice,
} from "../sidecar/enoki.js";

// Production format reference (issue #351): the Walrus register PTB pre-funds an
// exact WAL payment from the client's cached storage price, then asserts the
// coin is empty via `0x2::coin::destroy_zero`. When the on-chain price drops
// between the cached read and execution, the contract deducts less WAL and the
// leftover trips `destroy_zero` with ENonZero (abort code 0). Enoki surfaces it
// during its budget dry-run as a 400 dry_run_failed.

const PROD_DESTROY_ZERO_ERROR =
    'Enoki API error (400): {"errors":[{"code":"dry_run_failed","message":"Dry run failed, ' +
    "could not automatically determine a budget: MoveAbort(MoveLocation { module: ModuleId { " +
    "address: 0000000000000000000000000000000000000000000000000000000000000002, name: " +
    'Identifier(\\"balance\\") }, function: 9, instruction: 8, function_name: ' +
    'Some(\\"destroy_zero\\") }, 0) in command 2"}]}';

test("matches the verbatim prod destroy_zero abort", () => {
    assert.equal(isMoveAbortWalDestroyZero(PROD_DESTROY_ZERO_ERROR), true);
});

test("matches the compact MoveLocation shape", () => {
    assert.equal(
        isMoveAbortWalDestroyZero(
            "MoveAbort(MoveLocation { module: coin, function_name: Some(\"destroy_zero\") }, 0) in command 9",
        ),
        true,
    );
});

test("is case-insensitive on both anchors", () => {
    assert.equal(isMoveAbortWalDestroyZero("moveabort ... destroy_zero"), true);
});

test("bare destroy_zero without MoveAbort context is rejected", () => {
    // Guards against unrelated log lines that merely mention the function.
    assert.equal(isMoveAbortWalDestroyZero("calling coin::destroy_zero"), false);
});

test("balance::split abort does not match this detector", () => {
    // The stale-price destroy_zero path must stay disjoint from the gas-budget
    // balance::split path so the two handlers never double-fire.
    const balanceSplit =
        "MoveAbort(MoveLocation { module: balance, function_name: Some(\"split\") }, 2) in command 1";
    assert.equal(isMoveAbortWalDestroyZero(balanceSplit), false);
    assert.equal(isMoveAbortBalanceSplit(balanceSplit), true);
});

test("the destroy_zero abort is NOT matched by the balance-split detector", () => {
    // The prod message contains the `balance` module name but no `split`, so the
    // existing isMoveAbortBalanceSplit stays false — this is exactly the gap the
    // new detector closes.
    assert.equal(isMoveAbortBalanceSplit(PROD_DESTROY_ZERO_ERROR), false);
});

test("unrelated errors do not match", () => {
    assert.equal(isMoveAbortWalDestroyZero("connection refused"), false);
    assert.equal(isMoveAbortWalDestroyZero("HTTP 500 from upload relay"), false);
    assert.equal(isMoveAbortWalDestroyZero(""), false);
});

// Job 2b1cf6b0, Enoki budget dry-run, 2026-10-05. The shape is the gRPC
// abort text, not the older MoveLocation rendering above.
const CAREERACE_DESTROY_ZERO =
    "Enoki API error (400): {\"errors\":[{\"code\":\"dry_run_failed\",\"message\":\"Dry run failed, could not automatically determine a budget: MoveAbort in 4th command, abort code: 0, in '0x0000000000000000000000000000000000000000000000000000000000000002::balance::destroy_zero' (instruction 8)\",\"data\":{\"executionError\":{\"$kind\":\"MoveAbort\",\"message\":\"MoveAbort in 4th command, abort code: 0, in '0x0000000000000000000000000000000000000000000000000000000000000002::balance::destroy_zero' (instruction 8)\",\"command\":3,\"MoveAbort\":{\"abortCode\":\"0\",\"location\":{\"package\":\"0x0000000000000000000000000000000000000000000000000000000000000002\",\"module\":\"balance\",\"function\":9,\"instruction\":8,\"functionName\":\"destroy_zero\"}}}}}]}";

test("matches the careerace budget dry-run abort", () => {
    assert.equal(isMoveAbortWalDestroyZero(CAREERACE_DESTROY_ZERO), true);
    assert.equal(isMoveAbortBalanceSplit(CAREERACE_DESTROY_ZERO), false);
});

test("a stale-price abort refreshes the Walrus client and other errors do not", () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message?: unknown) => {
        warnings.push(String(message));
    };
    try {
        refreshWalrusClientOnStaleWalPrice(CAREERACE_DESTROY_ZERO);
        refreshWalrusClientOnStaleWalPrice("Object 0x" + "ab".repeat(32) + " not found");
        refreshWalrusClientOnStaleWalPrice("Sponsored transaction has expired");
    } finally {
        console.warn = warn;
    }
    assert.deepEqual(
        warnings.filter((line) => line.includes("[walrus/client] refreshed")),
        ["[walrus/client] refreshed reason=walrus_wal_payment_destroy_zero"],
    );
});

test("both upload routes drop the cached price on this abort", () => {
    const journal = readFileSync(new URL("../sidecar/routes/walrus-upload-journal.ts", import.meta.url), "utf8");
    const legacy = readFileSync(new URL("../sidecar/routes/walrus-upload.ts", import.meta.url), "utf8");
    assert.match(journal, /refreshWalrusClientOnStaleWalPrice\(message\)/);
    assert.match(legacy, /refreshWalrusClientOnStaleWalPrice\(message\)/);
});
