/**
 * Shared numeric constants used across the plugin.
 *
 * Centralised here to avoid magic numbers scattered in business logic.
 * Each constant documents its purpose and which modules consume it.
 */

// ============================================================================
// Capture filtering (capture.ts)
// ============================================================================

/** Minimum character length for a message to be considered capturable. */
export const MIN_CAPTURE_LENGTH = 30;

/** Messages with more emoji than this are treated as reactions, not facts. */
export const MAX_EMOJI_COUNT = 3;

// ============================================================================
// Text extraction (format.ts)
// ============================================================================

/** Messages shorter than this (after tag stripping) are dropped as trivial. */
export const MIN_EXTRACTED_TEXT_LENGTH = 10;

// ============================================================================
// Recall hook (hooks/recall.ts)
// ============================================================================

/** Prompts shorter than this skip the recall round-trip entirely. */
export const MIN_PROMPT_LENGTH = 10;

// ============================================================================
// Store tool (tools/store.ts)
// ============================================================================

/** Minimum trimmed length for text submitted to memory_store. */
export const MIN_STORE_TEXT_LENGTH = 3;

/** Max extracted facts shown in the store confirmation preview. */
export const MAX_FACT_PREVIEW_COUNT = 3;

/** Max characters of raw text shown as fallback preview. */
export const MAX_TEXT_PREVIEW_LENGTH = 100;

// ============================================================================
// Search tool (tools/search.ts)
// ============================================================================

/** Default result limit for memory_search when caller omits `limit`. */
export const DEFAULT_SEARCH_LIMIT = 5;

// ============================================================================
// Retry (format.ts → withRetry)
// ============================================================================

/** Default number of retry attempts (1 = 2 total tries). */
export const DEFAULT_RETRY_COUNT = 1;

/** Default delay in ms between retry attempts. */
export const DEFAULT_RETRY_DELAY_MS = 2000;
