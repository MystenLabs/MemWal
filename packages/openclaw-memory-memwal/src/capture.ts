/**
 * Capture filtering — determines whether a conversation turn
 * is worth sending to analyze() for fact extraction.
 *
 * Prevents wasted server calls on trivial turns like "ok", "thanks", emoji.
 * Based on patterns from LanceDB's shouldCapture() implementation.
 */

// ============================================================================
// Constants
// ============================================================================

const MIN_CAPTURE_LENGTH = 30;
const MAX_EMOJI_COUNT = 3;

/** Filler patterns — exact-match trivial responses. */
const FILLER_PATTERN = /^(ok|okay|sure|thanks|thank you|thx|yes|yep|yeah|no|nope|nah|got it|hmm|hm|ah|oh|lol|haha|nice|cool|great|right|alright|fine|k|kk)\s*[.!?]*$/i;

/** Prompt injection patterns — never capture these. */
const INJECTION_PATTERNS = [
  /ignore (all|any|previous|above|prior) instructions/i,
  /do not follow (the )?(system|developer)/i,
  /system prompt/i,
  /<\s*(system|assistant|developer|tool|function)\b/i,
  /\b(run|execute|call|invoke)\b.{0,40}\b(tool|command)\b/i,
];

/** Memory trigger patterns — always capture if matched (whitelist boost). */
const TRIGGER_PATTERNS = [
  /remember|prefer|radši|zapamatuj/i,
  /i (like|prefer|hate|love|want|need|use|am|work)/i,
  /my\s+\w+\s+is|is\s+my/i,
  /always|never|important/i,
  /decided|will use|switched to/i,
  /\+\d{10,}/,                       // phone numbers
  /[\w.-]+@[\w.-]+\.\w+/,            // email addresses
];

// ============================================================================
// Functions
// ============================================================================

/**
 * Check if text looks like a prompt injection attempt.
 * Used by both capture (reject on store) and recall (reject on inject).
 */
export function looksLikeInjection(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return INJECTION_PATTERNS.some((p) => p.test(normalized));
}

/**
 * Determine whether a conversation text is worth capturing.
 *
 * Returns true if the text likely contains memorable facts.
 * Returns false for trivial filler, system content, or injection attempts.
 */
export function shouldCapture(text: string): boolean {
  // Too short to contain useful facts
  if (text.length < MIN_CAPTURE_LENGTH) return false;

  // Pure filler response
  if (FILLER_PATTERN.test(text.trim())) return false;

  // System/XML content (likely injected context, not user speech)
  if (text.trim().startsWith("<") && text.includes("</")) return false;

  // Emoji-heavy (likely reactions, not factual content)
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > MAX_EMOJI_COUNT) return false;

  // Prompt injection attempt — never store
  if (INJECTION_PATTERNS.some((p) => p.test(text))) return false;

  // If it matches a trigger pattern, definitely capture
  if (TRIGGER_PATTERNS.some((p) => p.test(text))) return true;

  // Default: capture if it's long enough (the server LLM will decide what's worth keeping)
  return true;
}
