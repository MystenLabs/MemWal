import type { RecallOptions, RecallParams } from "./types.js";

/** String second argument is a namespace, not options. */
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
        return limitOrOptions;
    }
    throw new TypeError(invalidSecondArgMessage(method));
}

function invalidSecondArgMessage(method: string): string {
    const shared =
        `${method}() second argument must be a number (limit) or an options object, not a string. ` +
        `Namespace belongs in an options object (${method}(query, { namespace })) or as the third argument (${method}(query, limit, namespace)).`;
    if (method === "recall") {
        return `${shared} Preferred form: recall({ query, namespace }).`;
    }
    return shared;
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
