/**
 * Small dependency-free helpers shared across the sidecar.
 */

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return String(err);
}

export function errorName(err: unknown): string {
    if (err instanceof Error && err.name) return err.name;
    if (typeof err === "object" && err && "name" in err) {
        const name = (err as { name?: unknown }).name;
        if (typeof name === "string" && name.length > 0) return name;
    }
    return "Error";
}

export function formattedError(err: unknown): string {
    const name = errorName(err);
    const msg = errorMessage(err);
    return name && name !== "Error" ? `${name}: ${msg}` : msg;
}

export function shortAddress(address: unknown): string | undefined {
    if (typeof address !== "string") return undefined;
    if (address.length <= 18) return address;
    return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

export function truncateForLog(value: unknown, max = 500): string {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function dedupeAddresses(addresses: (string | null | undefined)[]): string[] {
    return [...new Set(addresses.filter((addr): addr is string => typeof addr === "string" && addr.length > 0))];
}

export function parseWalrusKeySlot(value: unknown): number | null {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
        return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
        const parsed = Number.parseInt(value, 10);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}

/**
 * Run async tasks with a bounded concurrency limit.
 * Avoids overwhelming Sui RPC with too many parallel calls (→ 429).
 */
export async function mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    async function worker() {
        while (true) {
            const i = index++;
            if (i >= items.length) break;
            results[i] = await fn(items[i]);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}
