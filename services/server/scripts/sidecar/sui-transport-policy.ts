export type SuiNetwork = "mainnet" | "testnet" | "devnet" | "localnet";

export function parseSuiNetwork(value: string | undefined): SuiNetwork {
    const normalized = (value || "mainnet").trim().toLowerCase();
    if (normalized === "mainnet" || normalized === "testnet" || normalized === "devnet" || normalized === "localnet") {
        return normalized;
    }
    throw new Error(`unsupported SUI_NETWORK=${value}; expected mainnet, testnet, devnet, or localnet`);
}

export function validateSuiTransportPolicy(input: {
    network: SuiNetwork;
    grpcUrl: string;
    txClientOverride: string;
}): void {
    if (input.network !== "testnet") return;
    if (!input.grpcUrl) {
        throw new Error("SUI_GRPC_URL is required when SUI_NETWORK=testnet; JSON-RPC is not supported");
    }
    if (input.txClientOverride === "jsonrpc") {
        throw new Error(
            "SIDECAR_SUI_TX_CLIENT=jsonrpc is localnet-only and cannot be used when SUI_NETWORK=testnet",
        );
    }
}
