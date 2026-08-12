import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import { SUI_TYPE } from "./config.js";

const COIN_WITH_BALANCE_INTENT = "CoinWithBalance";
const SUI_FRAMEWORK_ADDRESS = normalizeSuiAddress("0x2");

/**
 * Prevent the SDK's CoinWithBalance resolver from falling back to owned coins
 * when an address balance is insufficient.
 */
export function enforceAddressBalanceCoinIntents(transaction: Transaction): void {
    let initialOwnedObjectIds: Set<string> | undefined;
    let hasCoinWithBalanceIntents = false;
    transaction.addSerializationPlugin(async (transactionData, options, next) => {
        initialOwnedObjectIds ??= new Set(
            transactionData.inputs
                .map((input) => (
                    input.Object?.ImmOrOwnedObject?.objectId ?? input.UnresolvedObject?.objectId
                ))
                .filter((objectId): objectId is string => typeof objectId === "string"),
        );
        const requiredByType = new Map<string, bigint>();
        for (const command of transactionData.commands) {
            if (command.$kind !== "$Intent" || command.$Intent.name !== COIN_WITH_BALANCE_INTENT) {
                continue;
            }
            const type = command.$Intent.data?.type;
            const balance = command.$Intent.data?.balance;
            if (
                typeof type !== "string"
                || (typeof balance !== "bigint" && typeof balance !== "number" && typeof balance !== "string")
            ) {
                continue;
            }
            const coinType = type === "gas" ? SUI_TYPE : normalizeStructTag(type);
            requiredByType.set(coinType, (requiredByType.get(coinType) ?? 0n) + BigInt(balance));
        }

        if (requiredByType.size > 0) {
            hasCoinWithBalanceIntents = true;
            const client = options.client as any;
            if (!client?.core?.getBalance || !transactionData.sender) {
                throw new Error("Address-balance upload requires a sender and Sui client");
            }

            await Promise.all([...requiredByType.entries()].map(async ([coinType, required]) => {
                const response = await client.core.getBalance({
                    owner: transactionData.sender,
                    coinType,
                });
                const available = BigInt(response?.balance?.addressBalance ?? 0);
                if (available < required) {
                    throw new Error(
                        `Insufficient ${coinType} address balance: required ${required}, available ${available}`,
                    );
                }
            }));
        }

        await next();
        const newlyResolvedOwnedObjects = transactionData.inputs
            .map((input) => input.Object?.ImmOrOwnedObject?.objectId)
            .filter((objectId): objectId is string => (
                typeof objectId === "string" && !initialOwnedObjectIds.has(objectId)
            ));
        if (hasCoinWithBalanceIntents && newlyResolvedOwnedObjects.length > 0) {
            const client = options.client as any;
            if (!client?.core?.getObjects) {
                throw new Error("Address-balance upload could not verify newly resolved objects");
            }
            const response = await client.core.getObjects({ objectIds: newlyResolvedOwnedObjects });
            const coinObjectIds = response.objects.map((object: any) => {
                if (object instanceof Error) {
                    throw new Error(`Address-balance upload could not verify resolved object: ${object.message}`);
                }
                if (typeof object?.type !== "string") {
                    throw new Error(`Address-balance upload could not verify resolved object ${object?.objectId ?? ""}`);
                }
                const type = parseStructTag(object.type);
                return type.address === SUI_FRAMEWORK_ADDRESS
                    && type.module === "coin"
                    && type.name === "Coin"
                    ? object.objectId
                    : null;
            }).filter((objectId: unknown): objectId is string => typeof objectId === "string");

            if (coinObjectIds.length === 0) return;
            throw new Error(
                `Address-balance upload resolved owned coin objects: ${coinObjectIds.join(", ")}`,
            );
        }
    });

    transaction.addBuildPlugin(async (transactionData, _options, next) => {
        await next();
        if (transactionData.gasData.payment && transactionData.gasData.payment.length > 0) {
            throw new Error("Address-balance upload resolved gas from an owned coin");
        }
    });
}
