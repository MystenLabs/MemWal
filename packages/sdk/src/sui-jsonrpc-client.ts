/**
 * Resolve a JSON-RPC Sui client across @mysten/sui 2.5 (`SuiClient` on
 * `@mysten/sui/client`) and 2.6+ (`SuiJsonRpcClient` on `@mysten/sui/jsonRpc`).
 */

export type SuiJsonRpcModuleLoader = {
    loadClient?: () => Promise<any>;
    loadJsonRpc?: () => Promise<any>;
};

type JsonRpcSuiClientFactory = (
    url: string,
    loader?: SuiJsonRpcModuleLoader,
) => Promise<any>;

const SUI_JSONRPC_URLS: Record<string, string> = {
    testnet: "https://fullnode.testnet.sui.io:443",
    mainnet: "https://fullnode.mainnet.sui.io:443",
};

const JSON_RPC_CLIENT_MISSING =
    "JSON-RPC Sui client not found in @mysten/sui. Ensure @mysten/sui >=2.5.0 is installed.";

export function jsonRpcUrlForNetwork(network: string = "mainnet"): string {
    return SUI_JSONRPC_URLS[network] ?? SUI_JSONRPC_URLS.mainnet;
}

export async function resolveJsonRpcSuiClientConstructor(
    loader: SuiJsonRpcModuleLoader = {},
): Promise<(new (opts: { url: string }) => any) | undefined> {
    let SuiClient: any;
    try {
        const mod = loader.loadClient
            ? await loader.loadClient()
            : await import("@mysten/sui/client");
        SuiClient = mod?.SuiClient;
    } catch {
        /* not present on this version */
    }
    if (typeof SuiClient !== "function") {
        try {
            const mod = loader.loadJsonRpc
                ? await loader.loadJsonRpc()
                : await import("@mysten/sui/jsonRpc");
            SuiClient = mod?.SuiJsonRpcClient ?? mod?.SuiClient;
        } catch {
            /* not present on this version either */
        }
    }
    return typeof SuiClient === "function" ? SuiClient : undefined;
}

async function defaultCreateJsonRpcSuiClient(
    url: string,
    loader?: SuiJsonRpcModuleLoader,
): Promise<any> {
    const Client = await resolveJsonRpcSuiClientConstructor(loader);
    if (!Client) {
        throw new Error(JSON_RPC_CLIENT_MISSING);
    }
    return new Client({ url });
}

let createImpl: JsonRpcSuiClientFactory = defaultCreateJsonRpcSuiClient;

export async function createJsonRpcSuiClient(
    url: string,
    loader?: SuiJsonRpcModuleLoader,
): Promise<any> {
    if (loader) {
        return defaultCreateJsonRpcSuiClient(url, loader);
    }
    return createImpl(url);
}

/** Swap JSON-RPC client construction. Pass `undefined` to restore. @internal */
export function setCreateJsonRpcSuiClient(
    impl?: JsonRpcSuiClientFactory,
): void {
    createImpl = impl ?? defaultCreateJsonRpcSuiClient;
}
