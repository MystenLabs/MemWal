import assert from "node:assert/strict";
import test from "node:test";

import {
    SUI_COIN_TYPE,
    type SuiBalanceChange,
    escapePromLabel,
    extractTipMistFromBalanceChanges,
    relayHostLabel,
    renderWalmTipMetrics,
} from "../walm52-tip-metrics.js";

const RELAY_TIP_ADDR = "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77";
const SIGNER_ADDR = "0xaaaa000000000000000000000000000000000000000000000000000000000001";

function change(amount: string, ownerAddr: string, coinType: string = SUI_COIN_TYPE): SuiBalanceChange {
    return { amount, coinType, owner: { AddressOwner: ownerAddr } };
}

test("extractTipMistFromBalanceChanges sums positive SUI deltas addressed to tipRecipient", () => {
    const result = extractTipMistFromBalanceChanges(
        [
            change("-5000000", SIGNER_ADDR),
            change("4500000", RELAY_TIP_ADDR),
        ],
        RELAY_TIP_ADDR,
    );
    assert.equal(result, 4_500_000n);
});

test("returns 0n when tipRecipient is null (no-tip mode)", () => {
    const result = extractTipMistFromBalanceChanges(
        [change("4500000", RELAY_TIP_ADDR)],
        null,
    );
    assert.equal(result, 0n);
});

test("returns 0n when balance changes are null or empty (RPC returned no data)", () => {
    assert.equal(extractTipMistFromBalanceChanges(null, RELAY_TIP_ADDR), 0n);
    assert.equal(extractTipMistFromBalanceChanges(undefined, RELAY_TIP_ADDR), 0n);
    assert.equal(extractTipMistFromBalanceChanges([], RELAY_TIP_ADDR), 0n);
});

test("ignores non-SUI coin types even when addressed to tipRecipient", () => {
    const result = extractTipMistFromBalanceChanges(
        [change("4500000", RELAY_TIP_ADDR, "0x2::wal::WAL")],
        RELAY_TIP_ADDR,
    );
    assert.equal(result, 0n);
});

test("ignores negative deltas addressed to tipRecipient (defensive: tip never withdraws)", () => {
    const result = extractTipMistFromBalanceChanges(
        [change("-4500000", RELAY_TIP_ADDR)],
        RELAY_TIP_ADDR,
    );
    assert.equal(result, 0n);
});

test("ignores AddressOwner mismatch (tip going to a different relay)", () => {
    const otherRelay = "0x" + "ff".repeat(32);
    const result = extractTipMistFromBalanceChanges(
        [change("4500000", otherRelay)],
        RELAY_TIP_ADDR,
    );
    assert.equal(result, 0n);
});

test("ignores ObjectOwner / Shared / Immutable owners (only AddressOwner counts)", () => {
    const result = extractTipMistFromBalanceChanges(
        [
            { amount: "4500000", coinType: SUI_COIN_TYPE, owner: { ObjectOwner: RELAY_TIP_ADDR } },
            { amount: "4500000", coinType: SUI_COIN_TYPE, owner: { Shared: { initial_shared_version: "1" } } },
            { amount: "4500000", coinType: SUI_COIN_TYPE, owner: "Immutable" as unknown },
        ] as SuiBalanceChange[],
        RELAY_TIP_ADDR,
    );
    assert.equal(result, 0n);
});

test("sums multiple positive entries for the same tipRecipient (defensive: usually one, support N)", () => {
    const result = extractTipMistFromBalanceChanges(
        [
            change("1000000", RELAY_TIP_ADDR),
            change("2000000", RELAY_TIP_ADDR),
        ],
        RELAY_TIP_ADDR,
    );
    assert.equal(result, 3_000_000n);
});

test("address comparison is case-insensitive (Sui addresses are hex; SDK may return mixed case)", () => {
    const result = extractTipMistFromBalanceChanges(
        [change("4500000", RELAY_TIP_ADDR.toUpperCase().replace(/^0X/, "0x"))],
        RELAY_TIP_ADDR,
    );
    assert.equal(result, 4_500_000n);
});

test("malformed amount string contributes 0 (does not crash)", () => {
    const result = extractTipMistFromBalanceChanges(
        [
            { amount: "not-a-number", coinType: SUI_COIN_TYPE, owner: { AddressOwner: RELAY_TIP_ADDR } },
            change("123", RELAY_TIP_ADDR),
        ],
        RELAY_TIP_ADDR,
    );
    assert.equal(result, 123n);
});

test("relayHostLabel returns hostname without protocol/path", () => {
    assert.equal(relayHostLabel("https://upload-relay.mainnet.walrus.space"), "upload-relay.mainnet.walrus.space");
    assert.equal(relayHostLabel("http://internal-relay:9180/v1"), "internal-relay:9180");
});

test("relayHostLabel falls back to raw value on parse failure", () => {
    assert.equal(relayHostLabel("not a url"), "not a url");
});

test("escapePromLabel escapes backslash, quote, and newline", () => {
    assert.equal(escapePromLabel('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
});

test("renderWalmTipMetrics emits both counters with host + send_tip labels", () => {
    const out = renderWalmTipMetrics(
        { uploadsTotal: 7, tipMistTotal: 31_500_000n },
        { host: "upload-relay.mainnet.walrus.space", sendTip: true },
    );
    assert.match(out, /^# HELP walrus_upload_relay_uploads_total/m);
    assert.match(out, /^# TYPE walrus_upload_relay_uploads_total counter$/m);
    assert.match(out, /^walrus_upload_relay_uploads_total\{host="upload-relay\.mainnet\.walrus\.space",send_tip="true"\} 7$/m);
    assert.match(out, /^# HELP walrus_upload_relay_tip_mist_total/m);
    assert.match(out, /^# TYPE walrus_upload_relay_tip_mist_total counter$/m);
    assert.match(out, /^walrus_upload_relay_tip_mist_total\{host="upload-relay\.mainnet\.walrus\.space",send_tip="true"\} 31500000$/m);
});

test("renderWalmTipMetrics encodes send_tip=false (canary no-tip mode)", () => {
    const out = renderWalmTipMetrics(
        { uploadsTotal: 0, tipMistTotal: 0n },
        { host: "internal-relay:9180", sendTip: false },
    );
    assert.match(out, /send_tip="false"/);
    assert.match(out, /walrus_upload_relay_uploads_total\{[^}]+\} 0$/m);
    assert.match(out, /walrus_upload_relay_tip_mist_total\{[^}]+\} 0$/m);
});
