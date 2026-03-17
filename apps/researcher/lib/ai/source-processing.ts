import "server-only";

// --- URL extraction ---

const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\.0\.0\.1/,
  /^https?:\/\/0\.0\.0\.0/,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
];

export function extractUrlsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/\S+/gi;
  const matches = text.match(urlRegex) || [];

  // Clean trailing punctuation that's likely not part of the URL
  const cleaned = matches.map((url) => url.replace(/[),;:!?\]}>'"]+$/, ""));

  // Filter private/local IPs and deduplicate
  const filtered = cleaned.filter(
    (url) => !PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(url))
  );

  return [...new Set(filtered)];
}

// --- Source input types ---

export type SourceInput =
  | { type: "url"; url: string }
  | { type: "pdf"; fileUrl: string; fileName: string }
  | { type: "pdf-file"; file: File };
