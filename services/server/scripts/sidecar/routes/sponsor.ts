/**
 * Enoki sponsorship endpoints for the frontend.
 *
 *   POST /sponsor          — TransactionKind bytes + sender → sponsored { bytes, digest }
 *   POST /sponsor/execute  — { digest, signature } after user wallet signs → { digest }
 */

import express, { type Express } from "express";
import { ENOKI_API_KEY, ENOKI_NETWORK, JSON_LIMIT_METADATA } from "../config.js";
import { callEnoki, type EnokiExecuteResponse, type EnokiSponsorResponse } from "../enoki.js";
import { requestIdFor, sidecarLog } from "../log.js";
import { errorMessage } from "../util.js";

export function registerSponsorRoutes(app: Express): void {
    app.post("/sponsor", express.json({ limit: JSON_LIMIT_METADATA }), async (req, res) => {
        try {
            const { transactionBlockKindBytes, sender } = req.body;
            if (!transactionBlockKindBytes || !sender) {
                return res.status(400).json({ error: "Missing required fields: transactionBlockKindBytes, sender" });
            }
            if (!ENOKI_API_KEY) {
                return res.status(503).json({ error: "Enoki sponsorship is not configured (ENOKI_API_KEY missing)" });
            }

            // Redact full sender address (PII / deanonymisation) — log only
            // a short prefix for correlation. Never log the full digest here either.
            const senderPrefix = typeof sender === "string" ? sender.slice(0, 10) : "unknown";
            console.log(`[sponsor] creating sponsored tx for sender=${senderPrefix}...`);
            const sponsored = await callEnoki<EnokiSponsorResponse>("/transaction-blocks/sponsor", {
                network: ENOKI_NETWORK,
                transactionBlockKindBytes,
                sender,
            });

            console.log(`[sponsor] sponsored tx created (digest_len=${sponsored.digest.length})`);
            res.json(sponsored); // { bytes, digest }
        } catch (err: any) {
            const traceId = requestIdFor(req);
            const message = errorMessage(err);
            sidecarLog("error", "sponsor_failed", {
                requestId: traceId,
                error: message,
            });
            res.status(500).json({ error: message, traceId });
        }
    });

    app.post("/sponsor/execute", express.json({ limit: JSON_LIMIT_METADATA }), async (req, res) => {
        try {
            const { digest, signature } = req.body;
            if (!digest || !signature) {
                return res.status(400).json({ error: "Missing required fields: digest, signature" });
            }
            if (!ENOKI_API_KEY) {
                return res.status(503).json({ error: "Enoki sponsorship is not configured (ENOKI_API_KEY missing)" });
            }

            // Percent-encode digest before path interpolation. The digest is
            // attacker-controlled when the sidecar is reached directly (no auth,
            // S1 in audit) or via the Rust proxy which validates base58 but the
            // sidecar must not rely on that. encodeURIComponent neutralises any
            // path traversal (`..`), query injection (`?`), or fragment (`#`)
            // payloads in the digest segment.
            const encodedDigest = encodeURIComponent(digest);
            const executed = await callEnoki<EnokiExecuteResponse>(
                `/transaction-blocks/sponsor/${encodedDigest}`,
                { digest, signature }
            );

            // Redact digest from console logs — it's a high-cardinality
            // value that ties log lines to individual user transactions. Log only
            // a length indicator for diagnostics.
            console.log(`[sponsor/execute] executed sponsored tx (digest_len=${digest.length})`);
            res.json(executed); // { digest }
        } catch (err: any) {
            const traceId = requestIdFor(req);
            const message = errorMessage(err);
            sidecarLog("error", "sponsor_execute_failed", {
                requestId: traceId,
                error: message,
            });
            res.status(500).json({ error: message, traceId });
        }
    });
}
