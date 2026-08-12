const CHATBOT_USER_NAMESPACE_PREFIX = "chatbot-user:";

/**
 * Derive the private memory namespace for an authenticated chatbot user.
 * Returning null for a missing identity lets the request path fail closed
 * instead of falling back to the shared `default` namespace.
 */
export function memoryNamespaceForUser(userId: unknown): string | null {
  if (typeof userId !== "string") return null;
  const normalized = userId.trim();
  if (!normalized) return null;
  return `${CHATBOT_USER_NAMESPACE_PREFIX}${normalized}`;
}
