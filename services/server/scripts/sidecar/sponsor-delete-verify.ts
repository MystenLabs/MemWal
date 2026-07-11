/**
 * Delete-only PTB verification for the rate-limit-exempt sponsor path
 * (WALM-264). POST /sponsor with `deleteOnly: true` comes from the Rust
 * server's /sponsor-delete route, which skips BOTH sponsor rate-limit axes
 * (per-IP middleware and per-sender bucket) so a delete-all run over
 * hundreds of blobs isn't throttled mid-way. That exemption is only safe
 * because this check rejects anything that isn't strictly a cleanup
 * transaction — otherwise the flag would be a free bypass for sponsoring
 * arbitrary transactions.
 *
 * A kind passes iff every command is one of:
 *   - MoveCall `<walrus>::system::delete_blob` against the live Walrus
 *     package id (read from the on-chain System object — the same source
 *     the app's SDK resolves its target from), or
 *   - TransferObjects sending ONLY results of earlier commands (the
 *     reclaimed Storage objects) back to the sponsored sender itself.
 *     Inputs are rejected so the exempt path can't move pre-existing
 *     owned objects gaslessly, and any other recipient is rejected.
 * and at least one delete_blob is present.
 */

import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toHex } from "@mysten/sui/utils";

/** Returns null when the kind is a valid delete-only PTB, else a reason. */
export function verifyDeleteOnlyKind(
    kindBytesBase64: string,
    sender: string,
    walrusPackageId: string,
): string | null {
    let data: ReturnType<Transaction["getData"]>;
    try {
        data = Transaction.fromKind(fromBase64(kindBytesBase64)).getData();
    } catch {
        return "transactionBlockKindBytes is not a valid TransactionKind";
    }

    const commands = data.commands ?? [];
    if (commands.length === 0) return "transaction has no commands";

    const expectedPackage = normalizeSuiAddress(walrusPackageId);
    const expectedSender = normalizeSuiAddress(sender);
    let deleteCount = 0;

    for (const command of commands) {
        if (command.$kind === "MoveCall") {
            const call = command.MoveCall;
            if (
                normalizeSuiAddress(call.package) !== expectedPackage ||
                call.module !== "system" ||
                call.function !== "delete_blob"
            ) {
                return `only ${expectedPackage}::system::delete_blob calls are allowed`;
            }
            deleteCount++;
            continue;
        }

        if (command.$kind === "TransferObjects") {
            const transfer = command.TransferObjects;
            // Only results of the delete calls (reclaimed Storage) may move.
            for (const obj of transfer.objects) {
                if (obj.$kind !== "Result" && obj.$kind !== "NestedResult") {
                    return "TransferObjects may only move results of delete_blob calls";
                }
            }
            const address = transfer.address;
            if (address.$kind !== "Input") {
                return "TransferObjects recipient must be a pure input";
            }
            const input = data.inputs[address.Input];
            if (input?.$kind !== "Pure") {
                return "TransferObjects recipient must be a pure input";
            }
            const bytes = fromBase64(input.Pure.bytes);
            if (bytes.length !== 32 || `0x${toHex(bytes)}` !== expectedSender) {
                return "TransferObjects recipient must be the sender";
            }
            continue;
        }

        return `command kind ${command.$kind} is not allowed in a delete-only transaction`;
    }

    if (deleteCount === 0) return "transaction contains no delete_blob calls";
    return null;
}
