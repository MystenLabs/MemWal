import assert from "node:assert/strict";
import test from "node:test";

import { isMoveAbortBalanceSplit, isMoveAbortWalDestroyZero } from "../sidecar/enoki.js";

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
