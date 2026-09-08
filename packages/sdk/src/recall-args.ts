import type { RecallOptions, RecallParams } from "./types.js";

/**
 * Parse `limit` / options for deprecated positional recall-style calls.
 * A string second argument is the `recall(query, namespace)` footgun (#293).
 */
export function resolveLimitOrOptions<T extends { limit?: number; namespace?: string }>(
    method: string,
    limitOrOptions: number | T | undefined | null,
    namespace?: string,
    defaultLimit = 10,
): T {
    if (limitOrOptions == null) {
        return { limit: defaultLimit, namespace } as T;
    }
    if (typeof limitOrOptions === "number") {
        return { limit: limitOrOptions, namespace } as T;
    }
    if (typeof limitOrOptions === "object" && !Array.isArray(limitOrOptions)) {
        // Positional namespace fills an options object that omitted it.
        // An explicit options.namespace still wins, and the caller's object
        // is never mutated. (#1038)
        if (limitOrOptions.namespace === undefined && namespace !== undefined) {
            return { ...limitOrOptions, namespace } as T;
        }
        return limitOrOptions;
    }
    throw new TypeError(
        `${method}() second argument must be a number (limit) or an options object, not a string. ` +
            `Namespace goes in ${method}({ query, namespace }) or as the third argument: ` +
            `${method}(query, limit, namespace).`,
    );
}

/** Normalize object-style and positional `recall()` arguments. */
export function resolveRecallCall(
    queryOrParams: string | RecallParams,
    limitOrOptions?: number | RecallOptions | null,
    namespace?: string,
): { query: string; options: RecallOptions } {
    if (
        queryOrParams !== null &&
        typeof queryOrParams === "object" &&
        !Array.isArray(queryOrParams)
    ) {
        const { query, ...rest } = queryOrParams;
        return { query, options: rest };
    }
    if (typeof queryOrParams !== "string") {
        throw new TypeError(
            "recall() first argument must be a query string or a RecallParams object.",
        );
    }
    return {
        query: queryOrParams,
        options: resolveLimitOrOptions("recall", limitOrOptions, namespace),
    };
}
