/**
 * Default Sui client for the helpers that run without a relayer `/config`
 * (account management and MemWalManual).
 *
 * Mysten's public fullnodes no longer serve JSON-RPC, so the default is the
 * gRPC client. Callers that need another endpoint or transport pass their own
 * `suiClient`.
 */

const DEFAULT_SUI_GRPC_URLS: Record<string, string> = {
    testnet: "https://fullnode.testnet.sui.io:443",
    mainnet: "https://fullnode.mainnet.sui.io:443",
};

export async function createDefaultSuiClient(
    suiNetwork?: "testnet" | "mainnet",
): Promise<any> {
    const network = suiNetwork && DEFAULT_SUI_GRPC_URLS[suiNetwork] ? suiNetwork : "mainnet";

    let SuiGrpcClient: any;
    try {
        // @ts-ignore — optional peer dependency
        ({ SuiGrpcClient } = (await import("@mysten/sui/grpc")) as any);
    } catch {
        /* reported below */
    }
    if (typeof SuiGrpcClient !== "function") {
        throw new Error(
            "SuiGrpcClient not found in @mysten/sui/grpc. " +
                "Install @mysten/sui >=2.5.0, or pass suiClient."
        );
    }

    return new SuiGrpcClient({ network, baseUrl: DEFAULT_SUI_GRPC_URLS[network] });
}
