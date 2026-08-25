/**
 * Sui gRPC client — used for Enoki's on-chain registration flow.
 *
 * Sui's public JSON-RPC fullnodes were deprecated in 2026 in favor of gRPC.
 * @mysten/dapp-kit's SuiClientProvider/useSuiClient are still hard-typed to
 * SuiJsonRpcClient (confirmed against the latest published dapp-kit, 1.1.17)
 * and can't be swapped for a gRPC client, so this bypasses that provider
 * entirely for the one place noter needs live chain reads: registering an
 * Enoki wallet with @mysten/enoki (whose `client` option accepts the
 * ClientWithCoreApi interface both SuiJsonRpcClient and SuiGrpcClient
 * satisfy) and the on-chain account lookup/creation in enoki-login-card.tsx.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { enokiConfig } from "@/lib/enoki/config";

// Same hostnames Sui's own JSON-RPC used — gRPC-web is served from the same
// fullnode, dispatched by content-type/path rather than a separate host.
const GRPC_BASE_URLS = {
  testnet: "https://fullnode.testnet.sui.io:443",
  mainnet: "https://fullnode.mainnet.sui.io:443",
} as const;

let cached: SuiGrpcClient | null = null;
let cachedNetwork: keyof typeof GRPC_BASE_URLS | null = null;

/** Memoized SuiGrpcClient for the app's configured network. */
export function getSuiGrpcClient(): SuiGrpcClient {
  const network = enokiConfig.suiNetwork;
  if (cached && cachedNetwork === network) return cached;

  cached = new SuiGrpcClient({ network, baseUrl: GRPC_BASE_URLS[network] });
  cachedNetwork = network;
  return cached;
}
