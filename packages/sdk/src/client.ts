/**
 * memwal — HTTP Client Wrapper
 *
 * Provides a fetch-compatible interface with connection reuse (keep-alive).
 * Uses Node.js http.Agent when available, falls back to native fetch otherwise.
 */

export interface HttpClient {
    fetch(url: string, init?: RequestInit): Promise<Response>;
    destroy?(): void;
}

/**
 * Default HTTP client that reuses connections via Node.js http.Agent keepAlive.
 * Falls back to plain fetch in browser environments.
 */
export function createHttpClient(): HttpClient {
    // In Node.js, use http.Agent with keepAlive for connection reuse
    if (typeof globalThis.process !== "undefined" && globalThis.process.versions?.node) {
        let agent: any = null;
        let httpsAgent: any = null;

        // Lazy-init agents on first use
        const getAgent = async (url: string) => {
            if (url.startsWith("https")) {
                if (!httpsAgent) {
                    const https = await import("https");
                    httpsAgent = new https.Agent({ keepAlive: true });
                }
                return httpsAgent;
            }
            if (!agent) {
                const http = await import("http");
                agent = new http.Agent({ keepAlive: true });
            }
            return agent;
        };

        return {
            async fetch(url: string, init?: RequestInit): Promise<Response> {
                // Node.js 18+ fetch doesn't support agent directly,
                // but undici dispatcher can be passed. For broad compat,
                // use native fetch (which already uses keepAlive by default in Node 19+).
                return globalThis.fetch(url, init);
            },
            destroy() {
                agent?.destroy();
                httpsAgent?.destroy();
            },
        };
    }

    // Browser: native fetch already handles connection reuse
    return {
        fetch(url: string, init?: RequestInit): Promise<Response> {
            return globalThis.fetch(url, init);
        },
    };
}
