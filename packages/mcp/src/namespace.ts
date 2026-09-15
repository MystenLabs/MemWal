/**
 * Default-namespace injection for memory tools.
 *
 * `--namespace` / `MEMWAL_NAMESPACE` fill in a missing per-call namespace.
 * An explicit, non-empty `namespace` argument always wins.
 */

/** Memory tools that take a `namespace` argument. */
export const NAMESPACE_TOOLS = new Set([
    "memwal_remember",
    "memwal_remember_bulk",
    "memwal_recall",
    "memwal_analyze",
    "memwal_restore",
]);

/**
 * Return `args` with the configured default namespace filled in when the
 * agent omitted one. Does not mutate `args`.
 */
export function applyDefaultNamespace(
    toolName: string,
    args: Record<string, unknown>,
    namespace?: string,
): Record<string, unknown> {
    if (!namespace || !NAMESPACE_TOOLS.has(toolName)) return args;
    const current = args.namespace;
    if (typeof current === "string" && current.trim() !== "") return args;
    return { ...args, namespace };
}
