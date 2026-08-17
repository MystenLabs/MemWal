/**
 * One durable Walrus SDK boundary per request. Registration first returns an
 * exact signed transaction for the Rust writer to checkpoint; later requests
 * advance and return one checkpointable WriteBlobStep.
 */

import express, { type Express } from "express";
import type {
    WriteBlobStep,
    WriteBlobStepCertified,
    WriteBlobStepEncoded,
    WriteBlobStepRegistered,
    WriteBlobStepUploaded,
} from "@mysten/walrus";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { TransactionDataBuilder, type Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import {
    DEFAULT_WALRUS_EPOCHS,
    DURABLE_UPLOAD_PROTOCOL_VERSION,
    ENOKI_API_KEY,
    ENOKI_FALLBACK_TO_DIRECT_SIGN,
    ENOKI_NETWORK,
    JSON_LIMIT_WALRUS_UPLOAD,
    MAX_WALRUS_EPOCHS,
    SERVER_SUI_PRIVATE_KEYS,
    SUI_NETWORK,
    SUI_TYPE,
    WALRUS_PACKAGE_ID,
    parseDurableWalrusEpochs,
} from "../config.js";
import {
    getUploadRelayTipAddress,
    getWalrusClient,
    refreshWalrusClientIfStale,
    suiClient,
} from "../clients.js";
import { acquireWalrusUploadSlots } from "../concurrency.js";
import { requestIdFor, sanitizeRequestId, sidecarLog } from "../log.js";
import {
    classifyDurableSideEffectError,
    DurableSideEffectVerifyError,
    NoSideEffectError,
    withRpcRetry,
} from "../retry/rpc.js";
import { delayInjectedResponseOnce, errorMessage, parseWalrusKeySlot } from "../util.js";
import {
    DURABLE_WALLET_FALLBACK_POLICY,
    assertFinalizedTransactionSuccess,
    submitRebuildableWalletTransaction,
    trackWalletSubmission,
} from "../wallet.js";
import {
    blobObjectMatchesRegistration,
    chainBlobIdFromRaw,
    isWalrusBlobObjectType,
    readBlobObject,
} from "./walrus-query.js";
import { uploadWalrusBlobWithEffectsRetry } from "./walrus-upload.js";
import { enforceAddressBalanceCoinIntents } from "../address-balance.js";
import {
    callEnoki,
    type EnokiExecuteResponse,
    type EnokiSponsorResponse,
} from "../enoki.js";
import {
    assertUploadExecutionIdentity,
    executionIdentity,
    parseUploadExecutionIdentity,
} from "./health.js";

function parseResumeStep(raw: unknown): WriteBlobStep | null {
    if (raw === null || raw === undefined) return null;
    if (!raw || typeof raw !== "object") throw new Error("resumeStep must be an object");
    const step = (raw as any).step;
    if (!["encoded", "registered", "uploaded", "certified"].includes(step)) {
        throw new Error(`Invalid resumeStep.step: ${String(step)}`);
    }
    if (typeof (raw as any).blobId !== "string" || !(raw as any).blobId) {
        throw new Error("resumeStep.blobId is required");
    }
    if (step === "encoded") {
        if (typeof (raw as any).rootHash !== "string"
            || !Number.isSafeInteger((raw as any).unencodedSize)
            || (raw as any).unencodedSize < 0) {
            throw new Error("encoded resumeStep requires rootHash and unencodedSize");
        }
    } else {
        if (typeof (raw as any).blobObjectId !== "string" || !(raw as any).blobObjectId) {
            throw new Error(`${step} resumeStep requires blobObjectId`);
        }
        if (step === "registered" && (typeof (raw as any).txDigest !== "string" || !(raw as any).txDigest)) {
            throw new Error("registered resumeStep requires txDigest");
        }
        if (step === "uploaded" && (typeof (raw as any).certificate !== "string" || !(raw as any).certificate)) {
            throw new Error("uploaded resumeStep requires certificate");
        }
    }
    return raw as WriteBlobStep;
}

export async function readUploadBlobObject(
    blobObjectId: string,
    include: { json?: true; previousTransaction?: true },
    client: Pick<typeof suiClient, "getObject"> = suiClient,
) {
    return withRpcRetry(
        `[walrus/upload-step-v3] getObject ${blobObjectId}`,
        () => readBlobObject(blobObjectId, include, client),
        // Five capped sleeps keep replica lag in this flow for about 30 seconds.
        6,
    );
}

async function certifiedStep(
    blobId: string,
    blobObjectId: string,
): Promise<WriteBlobStepCertified | null> {
    const response = await readUploadBlobObject(blobObjectId, { json: true });
    const json = response.object.json as any;
    if (!json) throw new DurableSideEffectVerifyError(`Blob ${blobObjectId} has no JSON fields`);
    const chainBlobId = chainBlobIdFromRaw(json.blob_id ?? json.blobId);
    if (chainBlobId !== blobId) {
        throw new DurableSideEffectVerifyError(
            `Blob ${blobObjectId} id mismatch: expected ${blobId}, got ${chainBlobId}`,
        );
    }
    const certifiedEpoch = json.certified_epoch ?? json.certifiedEpoch ?? null;
    if (certifiedEpoch === null) return null;
    const blobObject = { ...json, id: blobObjectId, certified_epoch: certifiedEpoch };
    return { step: "certified", blobId, blobObjectId, blobObject };
}

export function durableRegisterDirectSigningAllowed(
    enokiConfigured: boolean,
    _fallbackToDirectSign: boolean,
): boolean {
    // When Enoki is configured, durable registration must fail closed rather
    // than silently draining the upload wallet after a sponsor outage. Direct
    // signing remains available only for deployments without Enoki (local/dev).
    return !enokiConfigured;
}

export function createdBlobObjectIdFromTransaction(result: any): string {
    const transaction = assertFinalizedTransactionSuccess(result, "registration transaction");
    const blobType = `${WALRUS_PACKAGE_ID}::blob::Blob`;
    const objectTypes = transaction.objectTypes ?? {};
    const matches = (transaction.effects?.changedObjects ?? [])
        .filter((object: any) => object?.idOperation === "Created")
        .map((object: any) => object.objectId)
        .filter((objectId: unknown): objectId is string => (
            typeof objectId === "string"
            && isWalrusBlobObjectType(objectTypes[objectId], blobType)
        ));
    if (matches.length !== 1) {
        throw new Error(`registration transaction created ${matches.length} Walrus Blob objects`);
    }
    return matches[0];
}

async function validateRegisteredBlob(
    blobObjectId: string,
    encoded: WriteBlobStepEncoded,
): Promise<void> {
    const response = await readUploadBlobObject(blobObjectId, { json: true });
    const json = response.object.json as any;
    if (!json
        || chainBlobIdFromRaw(json.blob_id ?? json.blobId) !== encoded.blobId
        || !blobObjectMatchesRegistration({
            rawSize: json.size ?? null,
            deletable: typeof json.deletable === "boolean" ? json.deletable : null,
        }, encoded.unencodedSize)) {
        throw new DurableSideEffectVerifyError(
            `registered Blob ${blobObjectId} does not match the encoded upload intent`,
        );
    }
}

function registeredStep(
    encoded: WriteBlobStepEncoded,
    blobObjectId: string,
    txDigest: string,
): WriteBlobStepRegistered {
    return {
        step: "registered",
        blobId: encoded.blobId,
        blobObjectId,
        txDigest,
        ...(encoded.nonce ? { nonce: encoded.nonce } : {}),
    };
}

export type PreparedRegisterTransaction = {
    transactionBytes: string;
    signature: string;
    digest: string;
    /** Enoki's sponsorship handle. Absent on legacy/direct-signed journals. */
    sponsorDigest?: string;
};

export type ValidatedPreparedRegisterTransaction = PreparedRegisterTransaction & {
    bytes: Uint8Array;
    maxEpoch?: bigint;
};

type PreparedRegisterClient = {
    getTransaction(options: {
        digest: string;
        include: { effects: true; objectTypes: true };
    }): Promise<unknown>;
    executeTransaction(options: {
        transaction: Uint8Array;
        signatures: string[];
        include: { effects: true; objectTypes: true };
    }): Promise<unknown>;
};

type PreparedRegisterSponsorExecutor = (
    sponsorDigest: string,
    signature: string,
) => Promise<EnokiExecuteResponse>;

async function executePreparedRegisterWithEnoki(
    sponsorDigest: string,
    signature: string,
): Promise<EnokiExecuteResponse> {
    return callEnoki<EnokiExecuteResponse>(
        `/transaction-blocks/sponsor/${encodeURIComponent(sponsorDigest)}`,
        { digest: sponsorDigest, signature },
    );
}

function parsePreparedRegisterTransaction(raw: unknown): PreparedRegisterTransaction | null {
    if (raw === null || raw === undefined) return null;
    if (!raw || typeof raw !== "object") {
        throw new Error("registerTransaction must be an object");
    }
    const { transactionBytes, signature, digest, sponsorDigest } = raw as Record<string, unknown>;
    if (typeof transactionBytes !== "string" || !transactionBytes
        || typeof signature !== "string" || !signature
        || typeof digest !== "string" || !digest) {
        throw new Error("registerTransaction requires transactionBytes, signature, and digest");
    }
    if (sponsorDigest !== undefined && (typeof sponsorDigest !== "string" || !sponsorDigest)) {
        throw new Error("registerTransaction.sponsorDigest must be a non-empty string");
    }
    return {
        transactionBytes,
        signature,
        digest,
        ...(typeof sponsorDigest === "string" ? { sponsorDigest } : {}),
    };
}

export async function prepareRegisterTransaction(
    transaction: Transaction,
    signer: Ed25519Keypair,
    allowedAddresses: string[] = [signer.toSuiAddress()],
): Promise<PreparedRegisterTransaction> {
    const signerAddress = signer.toSuiAddress();
    transaction.setSenderIfNotSet(signerAddress);

    if (ENOKI_API_KEY) {
        // Journal the exact sponsored bytes before execution. Replays use the
        // Enoki sponsorship handle below, so the upload remains idempotent
        // without making the sender wallet the gas owner.
        const transactionKind = await transaction.build({
            client: suiClient as any,
            onlyTransactionKind: true,
        });
        const sponsored = await callEnoki<EnokiSponsorResponse>(
            "/transaction-blocks/sponsor",
            {
                network: ENOKI_NETWORK,
                transactionBlockKindBytes: Buffer.from(transactionKind).toString("base64"),
                sender: signerAddress,
                ...(allowedAddresses.length ? { allowedAddresses } : {}),
            },
        );
        const bytes = new Uint8Array(Buffer.from(sponsored.bytes, "base64"));
        if (!bytes.length || Buffer.from(bytes).toString("base64") !== sponsored.bytes) {
            throw new Error("Enoki returned non-canonical sponsored transaction bytes");
        }
        const transactionData = TransactionDataBuilder.fromBytes(bytes);
        assertSponsoredRegisterTransaction(transactionData, signerAddress);
        const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
        const signed = await signer.signTransaction(bytes);
        return {
            transactionBytes: signed.bytes,
            signature: signed.signature,
            digest,
            sponsorDigest: sponsored.digest,
        };
    }

    if (!durableRegisterDirectSigningAllowed(false, ENOKI_FALLBACK_TO_DIRECT_SIGN)) {
        throw new Error("durable register requires Enoki sponsorship");
    }
    transaction.setGasPayment([]);
    const bytes = await transaction.build({ client: suiClient });
    assertAddressBalanceRegisterTransaction(TransactionDataBuilder.fromBytes(bytes));
    const signed = await signer.signTransaction(bytes);
    return {
        transactionBytes: signed.bytes,
        signature: signed.signature,
        digest: TransactionDataBuilder.getDigestFromBytes(bytes),
    };
}

function assertRegisterTransactionUsesAddressBalanceWal(
    transactionData: TransactionDataBuilder,
): void {
    let usesGasCoin = false;
    transactionData.mapArguments((argument) => {
        if (argument.$kind === "GasCoin") usesGasCoin = true;
        return argument;
    });
    if (usesGasCoin) {
        throw new Error("registerTransaction resolved the relay tip from an owned SUI coin");
    }

    const ownedInputs = transactionData.inputs.filter(
        (input) => input.Object?.ImmOrOwnedObject,
    );
    if (ownedInputs.length > 0) {
        throw new Error("registerTransaction resolved WAL from an owned coin");
    }
    const suiType = normalizeStructTag(SUI_TYPE);
    const hasWalWithdrawal = transactionData.inputs.some(
        (input) => input.$kind === "FundsWithdrawal"
            && normalizeStructTag(input.FundsWithdrawal.typeArg.Balance) !== suiType,
    );
    if (!hasWalWithdrawal) {
        throw new Error("registerTransaction has no WAL address-balance withdrawal");
    }
}

export function assertSponsoredRegisterTransaction(
    transactionData: TransactionDataBuilder,
    expectedWalletAddress: string,
): void {
    const walletAddress = normalizeSuiAddress(expectedWalletAddress);
    if (!transactionData.sender
        || normalizeSuiAddress(transactionData.sender) !== walletAddress) {
        throw new Error("sponsored registerTransaction sender does not match the wallet");
    }
    if (!transactionData.gasData.owner
        || normalizeSuiAddress(transactionData.gasData.owner) === walletAddress) {
        throw new Error("sponsored registerTransaction must use a distinct gas owner");
    }
    assertRegisterTransactionUsesAddressBalanceWal(transactionData);
}

export function assertAddressBalanceRegisterTransaction(
    transactionData: TransactionDataBuilder,
): bigint {
    if (transactionData.gasData.payment?.length !== 0) {
        throw new Error("registerTransaction must pay gas from the address balance");
    }

    const expiration = transactionData.expiration;
    if (
        expiration?.$kind !== "ValidDuring"
        || expiration.ValidDuring.minTimestamp !== null
        || expiration.ValidDuring.maxTimestamp !== null
    ) {
        throw new Error("registerTransaction must use a ValidDuring address-balance expiration");
    }

    assertRegisterTransactionUsesAddressBalanceWal(transactionData);
    return BigInt(expiration.ValidDuring.maxEpoch);
}

export async function validatePreparedRegisterTransaction(
    prepared: PreparedRegisterTransaction,
    expectedWalletAddress: string,
): Promise<ValidatedPreparedRegisterTransaction> {
    const bytes = new Uint8Array(Buffer.from(prepared.transactionBytes, "base64"));
    if (!bytes.length || Buffer.from(bytes).toString("base64") !== prepared.transactionBytes) {
        throw new Error("registerTransaction.transactionBytes is not canonical base64");
    }
    const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
    if (digest !== prepared.digest) {
        throw new Error(`registerTransaction digest mismatch: expected ${prepared.digest}, got ${digest}`);
    }

    let transactionData: TransactionDataBuilder;
    try {
        transactionData = TransactionDataBuilder.fromBytes(bytes);
    } catch (error: unknown) {
        throw new Error(`registerTransaction contains invalid TransactionData: ${errorMessage(error)}`);
    }
    const walletAddress = normalizeSuiAddress(expectedWalletAddress);
    if (!transactionData.sender
        || normalizeSuiAddress(transactionData.sender) !== walletAddress) {
        throw new Error("registerTransaction sender does not match the journaled wallet");
    }
    if (prepared.sponsorDigest) {
        assertSponsoredRegisterTransaction(transactionData, walletAddress);
    } else if (!transactionData.gasData.owner
        || normalizeSuiAddress(transactionData.gasData.owner) !== walletAddress) {
        throw new Error("registerTransaction gas owner does not match the journaled wallet");
    }
    // Protocol-v3 journals created before address-balance enforcement may mix
    // address-balance gas with owned WAL coins. Preserve their exact bytes;
    // every newly prepared transaction is checked above before journaling.
    const maxEpoch = transactionData.expiration?.$kind === "ValidDuring"
        ? BigInt(transactionData.expiration.ValidDuring.maxEpoch)
        : undefined;
    await verifyTransactionSignature(bytes, prepared.signature, { address: walletAddress });
    return { ...prepared, bytes, maxEpoch };
}

let currentEpochCache: { epoch: bigint; loadedAtMs: number } | undefined;
async function currentSuiEpoch(): Promise<bigint> {
    if (currentEpochCache && Date.now() - currentEpochCache.loadedAtMs < 5_000) {
        return currentEpochCache.epoch;
    }
    const { systemState } = await suiClient.core.getCurrentSystemState();
    const epoch = BigInt(systemState.epoch);
    currentEpochCache = { epoch, loadedAtMs: Date.now() };
    return epoch;
}

export async function executePreparedRegisterTransaction(
    prepared: ValidatedPreparedRegisterTransaction,
    client: PreparedRegisterClient = suiClient,
    onTransactionObservedOrSubmitted: () => void = () => {},
    getCurrentEpoch: () => Promise<bigint> = currentSuiEpoch,
    mayHaveBeenSubmitted = false,
    executeSponsored: PreparedRegisterSponsorExecutor = executePreparedRegisterWithEnoki,
): Promise<unknown> {
    const include = { effects: true, objectTypes: true } as const;
    const assertExpectedDigest = (result: any): unknown => {
        const digest = result?.Transaction?.digest ?? result?.FailedTransaction?.digest;
        if (digest !== prepared.digest) {
            throw new Error(`register transaction response digest mismatch: expected ${prepared.digest}, got ${String(digest)}`);
        }
        return result;
    };
    let existing: unknown;
    try {
        existing = await client.getTransaction({ digest: prepared.digest, include });
    } catch (error: any) {
        if (error?.code !== "NOT_FOUND") throw error;
    }
    if (existing !== undefined) {
        onTransactionObservedOrSubmitted();
        return assertExpectedDigest(existing);
    }
    const maxEpoch = prepared.maxEpoch;
    if (maxEpoch !== undefined && await getCurrentEpoch() > maxEpoch) {
        if (mayHaveBeenSubmitted) {
            throw Object.assign(
                new Error(
                    `prepared register transaction ${prepared.digest} expired at epoch ${maxEpoch} but remains ambiguous`,
                ),
                { code: "UNAVAILABLE" },
            );
        }
        throw new NoSideEffectError(
            `prepared register transaction ${prepared.digest} expired at epoch ${maxEpoch} and is not on chain`,
        );
    }
    // TransactionData bytes determine the Sui digest. Re-executing this exact
    // signed payload can only submit the already-journaled digest.
    onTransactionObservedOrSubmitted();
    if (prepared.sponsorDigest) {
        const executed = await trackWalletSubmission(() =>
            executeSponsored(prepared.sponsorDigest!, prepared.signature),
        );
        if (executed.digest !== prepared.digest) {
            throw new Error(
                `Enoki executed unexpected register digest: expected ${prepared.digest}, got ${executed.digest}`,
            );
        }
        // Enoki returns only a digest. Read the finalized transaction so the
        // caller can validate the created Walrus Blob object exactly as it did
        // for the legacy direct-execution path.
        for (let attempt = 1; attempt <= 8; attempt += 1) {
            try {
                const finalized = await client.getTransaction({ digest: prepared.digest, include });
                return assertExpectedDigest(finalized);
            } catch (error: any) {
                if (error?.code !== "NOT_FOUND" || attempt === 8) throw error;
                await new Promise((resolve) => setTimeout(resolve, attempt * 250));
            }
        }
        throw new Error(`sponsored register transaction ${prepared.digest} was not found after execution`);
    }

    const result = await trackWalletSubmission(() =>
        client.executeTransaction({
            transaction: prepared.bytes,
            signatures: [prepared.signature],
            include,
        }),
    );
    return assertExpectedDigest(result);
}

export function registerWalrusUploadJournalRoute(app: Express): void {
    app.post(
        "/walrus/upload-step-v3",
        express.json({ limit: JSON_LIMIT_WALRUS_UPLOAD }),
        async (req, res) => {
            const traceId = requestIdFor(req);
            let phase = "request";
            let releaseWalrusUploadSlots: (() => void) | undefined;
            let phaseCanSubmitSideEffect = false;
            let submissionStarted = false;
            try {
                const {
                    data,
                    keyIndex,
                    jobId: rawJobId,
                    walletAddress: rawWalletAddress,
                    owner,
                    namespace,
                    packageId,
                    uploadExecutionIdentity: rawExecutionIdentity,
                    uploadProtocolVersion,
                    epochs: rawEpochs = DEFAULT_WALRUS_EPOCHS,
                    reconcileOnly = false,
                    registerTransaction: rawRegisterTransaction,
                    resumeStep: rawResumeStep,
                } = req.body;
                const jobId = sanitizeRequestId(rawJobId);
                if (!data || keyIndex === undefined || !jobId) {
                    return res.status(400).json({ error: "Missing required fields: data, keyIndex, jobId" });
                }
                if (owner && !/^0x[0-9a-fA-F]{64}$/.test(owner)) {
                    return res.status(400).json({ error: "Invalid owner address format" });
                }
                const targetOwner = owner ? normalizeSuiAddress(owner) : owner;
                if (packageId && !/^0x[0-9a-fA-F]{1,64}$/.test(packageId)) {
                    return res.status(400).json({ error: "Invalid packageId format" });
                }
                const keySlot = parseWalrusKeySlot(keyIndex);
                if (keySlot === null || !SERVER_SUI_PRIVATE_KEYS[keySlot]) {
                    return res.status(400).json({ error: `Invalid keyIndex: ${keyIndex}` });
                }
                const { secretKey } = decodeSuiPrivateKey(SERVER_SUI_PRIVATE_KEYS[keySlot]);
                const signer = Ed25519Keypair.fromSecretKey(secretKey);
                const signerAddress = signer.toSuiAddress();
                const walletAddress = rawWalletAddress ?? signerAddress;
                if (!/^0x[0-9a-fA-F]{64}$/.test(walletAddress)) {
                    return res.status(400).json({ error: "Invalid walletAddress format" });
                }
                // New Rust callers can omit walletAddress on the first prepare;
                // the sidecar derives it from the pinned key slot. Subsequent
                // replay requests persist and send the derived address.
                const journaledWalletAddress = normalizeSuiAddress(walletAddress);
                const epochs = parseDurableWalrusEpochs(rawEpochs);
                if (epochs === null) {
                    return res.status(400).json({
                        error: SUI_NETWORK === "mainnet"
                            ? `Invalid epochs: mainnet requires exactly ${MAX_WALRUS_EPOCHS}, got ${String(rawEpochs)}`
                            : `Invalid epochs: expected an integer from 1 to ${MAX_WALRUS_EPOCHS}, got ${String(rawEpochs)}`,
                    });
                }

                // A malformed resumeStep is a caller bug, not an ambiguous
                // durable phase: reject it as a 400 before the durable section
                // so it never surfaces as a protocol-ambiguous 500.
                let resume: WriteBlobStep | null;
                let preparedRegisterTransaction: PreparedRegisterTransaction | null;
                try {
                    resume = parseResumeStep(rawResumeStep);
                    preparedRegisterTransaction = parsePreparedRegisterTransaction(rawRegisterTransaction);
                } catch (resumeError: unknown) {
                    return res.status(400).json({ error: errorMessage(resumeError) });
                }
                phase = !resume
                    ? "encode"
                    : resume.step === "encoded"
                        ? preparedRegisterTransaction
                            ? "register_execute"
                            : "register_prepare"
                        : resume.step;
                if (preparedRegisterTransaction && resume?.step !== "encoded") {
                    return res.status(400).json({
                        error: "registerTransaction is valid only with an encoded resumeStep",
                    });
                }
                if (uploadProtocolVersion !== DURABLE_UPLOAD_PROTOCOL_VERSION) {
                    return res.status(409).json({
                        error: `upload protocol mismatch: expected ${DURABLE_UPLOAD_PROTOCOL_VERSION}, got ${String(uploadProtocolVersion)}`,
                        code: "UPLOAD_PROTOCOL_VERSION_MISMATCH",
                        expectedUploadProtocolVersion: DURABLE_UPLOAD_PROTOCOL_VERSION,
                        actualUploadProtocolVersion: uploadProtocolVersion ?? null,
                    });
                }
                phaseCanSubmitSideEffect = !reconcileOnly
                    && (resume?.step === "encoded" || resume?.step === "uploaded");
                const uploadExecutionIdentity = rawExecutionIdentity === undefined
                    ? null
                    : parseUploadExecutionIdentity(rawExecutionIdentity);
                if (rawExecutionIdentity !== undefined && !uploadExecutionIdentity) {
                    return res.status(400).json({ error: "Invalid uploadExecutionIdentity" });
                }
                if (uploadExecutionIdentity) await assertUploadExecutionIdentity(uploadExecutionIdentity);
                releaseWalrusUploadSlots = await acquireWalrusUploadSlots(keySlot, traceId, jobId);
                if (signerAddress !== journaledWalletAddress) {
                    return res.status(409).json({
                        error: "keyIndex no longer maps to the journaled wallet",
                        code: "WALLET_MAPPING_MISMATCH",
                        expectedWalletAddress: journaledWalletAddress,
                        actualWalletAddress: signerAddress,
                    });
                }
                const blobData = new Uint8Array(Buffer.from(data, "base64"));
                refreshWalrusClientIfStale();
                const client = getWalrusClient();
                const flow = client.writeBlobFlow({
                    blob: blobData,
                    ...(resume ? { resume } : {}),
                });

                let step: WriteBlobStep;
                if (!resume) {
                    step = await flow.encode();
                } else if (resume.step === "encoded") {
                    const encoded = await flow.encode();
                    if (preparedRegisterTransaction) {
                        let validated: ValidatedPreparedRegisterTransaction;
                        try {
                            validated = await validatePreparedRegisterTransaction(
                                preparedRegisterTransaction,
                                journaledWalletAddress,
                            );
                        } catch (validationError: unknown) {
                            return res.status(409).json({
                                error: errorMessage(validationError),
                                code: "INVALID_PREPARED_REGISTER_TRANSACTION",
                                jobId,
                            });
                        }
                        phaseCanSubmitSideEffect = true;
                        // A persisted *_started marker means an earlier request
                        // may already have submitted these exact bytes. Until a
                        // digest lookup proves absence, lookup failures must
                        // preserve the prepared transaction for reconciliation.
                        if (reconcileOnly) submissionStarted = true;
                        const result = await executePreparedRegisterTransaction(
                            validated,
                            suiClient,
                            () => {
                                // A successful digest lookup proves the effect
                                // already exists; an execute call may create it.
                                submissionStarted = true;
                            },
                            currentSuiEpoch,
                            reconcileOnly,
                        );
                        const blobObjectId = createdBlobObjectIdFromTransaction(result);
                        await validateRegisteredBlob(blobObjectId, encoded);
                        step = registeredStep(encoded, blobObjectId, validated.digest);
                    } else {
                        if (reconcileOnly) {
                            return res.status(409).json({
                                error: "register reconciliation requires the journaled signed transaction",
                                code: "MISSING_PREPARED_REGISTER_TRANSACTION",
                                jobId,
                                blobId: encoded.blobId,
                            });
                        }
                        const registerTx = flow.register({
                            epochs,
                            owner: signerAddress,
                            deletable: true,
                            attributes: {
                                ...(namespace ? { memwal_namespace: namespace } : {}),
                                ...(targetOwner ? { memwal_owner: targetOwner } : {}),
                                ...(packageId ? { memwal_package_id: packageId } : {}),
                                memwal_migration_job: jobId,
                            },
                        });
                        enforceAddressBalanceCoinIntents(registerTx);
                        const tipRecipient = ENOKI_API_KEY
                            ? await getUploadRelayTipAddress()
                            : null;
                        const allowedAddresses = [...new Set(
                            [signerAddress, tipRecipient]
                                .filter((address): address is string => typeof address === "string"),
                        )];
                        const registerTransaction = await prepareRegisterTransaction(
                            registerTx,
                            signer,
                            allowedAddresses,
                        );
                        console.log(`[walrus/upload-step-v3] [${traceId}] prepared ${JSON.stringify({
                            jobId,
                            keyIndex: keySlot,
                            step: "register_prepared",
                            blobId: encoded.blobId,
                            digest: registerTransaction.digest,
                            sponsored: !!registerTransaction.sponsorDigest,
                        })}`);
                        return res.json({
                            registerTransaction,
                            resumeStep: encoded,
                            walletAddress: signerAddress,
                            uploadExecutionIdentity: await executionIdentity(),
                        });
                    }
                } else if (resume.step === "registered") {
                    const alreadyCertified = await certifiedStep(resume.blobId, resume.blobObjectId);
                    if (alreadyCertified) {
                        step = alreadyCertified;
                    } else {
                        await flow.encode();
                        step = await uploadWalrusBlobWithEffectsRetry(flow, resume.txDigest, {
                            traceId,
                            jobId,
                            keyIndex: keySlot,
                        }, true) as WriteBlobStepUploaded;
                    }
                } else if (resume.step === "uploaded") {
                    const alreadyCertified = await certifiedStep(resume.blobId, resume.blobObjectId);
                    if (alreadyCertified) {
                        step = alreadyCertified;
                    } else if (reconcileOnly) {
                        return res.status(409).json({
                            error: "Blob is not certified after an ambiguous certify phase",
                            code: "AMBIGUOUS_CERTIFY_NOT_FOUND",
                            jobId,
                            blobId: resume.blobId,
                            objectId: resume.blobObjectId,
                        });
                    } else {
                        const digest = await submitRebuildableWalletTransaction(
                            "certify_sponsor",
                            () => client.certifyBlobTransaction({
                                blobId: resume.blobId,
                                blobObjectId: resume.blobObjectId,
                                certificate: resume.certificate,
                                deletable: true,
                            }),
                            signer,
                            undefined,
                            { traceId, jobId, keyIndex: keySlot },
                            DURABLE_WALLET_FALLBACK_POLICY,
                            () => {
                                submissionStarted = true;
                            },
                        );
                        const result = await suiClient.waitForTransaction({ digest });
                        assertFinalizedTransactionSuccess(
                            result,
                            `certification transaction ${digest}`,
                        );
                        const certified = await certifiedStep(resume.blobId, resume.blobObjectId);
                        if (!certified) throw new Error(`certified Blob ${resume.blobObjectId} is not certified on chain`);
                        step = certified;
                    }
                } else {
                    step = resume;
                }

                console.log(`[walrus/upload-step-v3] [${traceId}] ok ${JSON.stringify({
                    jobId,
                    keyIndex: keySlot,
                    step: step.step,
                    blobId: step.blobId,
                    reconcileOnly: !!reconcileOnly,
                })}`);
                await delayInjectedResponseOnce(submissionStarted, jobId);
                return res.json({ step });
            } catch (error: unknown) {
                const message = errorMessage(error);
                sidecarLog("error", "walrus_upload_step_failed", {
                    requestId: traceId,
                    phase,
                    error: message,
                });
                const durableError = classifyDurableSideEffectError(
                    error,
                    phaseCanSubmitSideEffect,
                    submissionStarted,
                );
                if (durableError) {
                    const status = durableError.code === "DURABLE_SIDE_EFFECT_VERIFY_FAILED" ? 422 : 503;
                    return res.status(status).json({
                        error: message,
                        ...durableError,
                        traceId,
                    });
                }
                return res.status(500).json({ error: message, traceId });
            } finally {
                releaseWalrusUploadSlots?.();
            }
        },
    );
}
