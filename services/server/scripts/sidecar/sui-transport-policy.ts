export type SuiNetwork = "mainnet" | "testnet" | "devnet" | "localnet";

export function parseSuiNetwork(value: string | undefined): SuiNetwork {
    const normalized = (value || "mainnet").trim().toLowerCase();
    if (normalized === "mainnet" || normalized === "testnet" || normalized === "devnet" || normalized === "localnet") {
        return normalized;
    }
    throw new Error(`unsupported SUI_NETWORK=${value}; expected mainnet, testnet, devnet, or localnet`);
}
