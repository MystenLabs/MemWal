/**
 * MemWal V2 — Core Types
 *
 * Ed25519 delegate key based SDK that communicates with
 * the MemWal Rust server (TEE).
 */

// ============================================================
// Config
// ============================================================

export interface MemWalConfig {
    /** Ed25519 private key (hex string). This is the delegate key from app.memwal.com */
    key: string;
    /** Server URL (default: http://localhost:3001) */
    serverUrl?: string;
}

// ============================================================
// API Types
// ============================================================

/** Result from remember() */
export interface RememberResult {
    id: string;
    blobId: string;
    owner: string;
}

/** A single recalled memory */
export interface RecallMemory {
    blobId: string;
    text: string;
    distance: number;
}

/** Result from recall() */
export interface RecallResult {
    results: RecallMemory[];
    total: number;
}

/** Result from embed() */
export interface EmbedResult {
    vector: number[];
}

/** A single extracted fact */
export interface AnalyzedFact {
    text: string;
    id: string;
    blobId: string;
}

/** Result from analyze() */
export interface AnalyzeResult {
    facts: AnalyzedFact[];
    total: number;
    owner: string;
}

/** Server health response */
export interface HealthResult {
    status: string;
    version: string;
}
