export const MAX_MEMORY_TEXT_BYTES = 64 * 1024;

export function memoryTextWithinLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= MAX_MEMORY_TEXT_BYTES;
}
