"use client";

import { useEffect } from "react";
import {
  createNetworkConfig,
  SuiClientProvider,
  WalletProvider,
} from "@mysten/dapp-kit";
import { isEnokiNetwork, registerEnokiWallets } from "@mysten/enoki";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { enokiConfig } from "@/lib/enoki/config";
import { getSuiGrpcClient } from "@/lib/sui/grpc-client";

const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" },
  mainnet: { url: getJsonRpcFullnodeUrl("mainnet"), network: "mainnet" },
});

/**
 * Registers Enoki wallets (Google OAuth) with dapp-kit on mount. No-op if env
 * vars are missing.
 *
 * Uses a standalone SuiGrpcClient rather than SuiClientProvider's client:
 * dapp-kit's SuiClientProvider is hard-typed to SuiJsonRpcClient (even in the
 * latest published version), and Sui's public JSON-RPC fullnodes no longer
 * serve JSON-RPC — so useSuiClientContext()'s client can't be used here.
 * Enoki's `client` option accepts the same ClientWithCoreApi interface a
 * gRPC client satisfies, so this is otherwise a drop-in swap.
 */
function RegisterEnokiWallets() {
  useEffect(() => {
    const network = enokiConfig.suiNetwork;
    if (!isEnokiNetwork(network)) return;
    if (!enokiConfig.enokiApiKey || !enokiConfig.googleClientId) return;

    const { unregister } = registerEnokiWallets({
      apiKey: enokiConfig.enokiApiKey,
      providers: {
        google: { clientId: enokiConfig.googleClientId },
      },
      client: getSuiGrpcClient(),
      network,
    });

    return unregister;
  }, []);

  return null;
}

/** Sui + Enoki provider stack. Does NOT include React Query — noter's TRPCProvider handles that. */
export function SuiProviders({ children }: { children: React.ReactNode }) {
  return (
    <SuiClientProvider
      networks={networkConfig}
      defaultNetwork={enokiConfig.suiNetwork}
    >
      <RegisterEnokiWallets />
      <WalletProvider autoConnect>{children}</WalletProvider>
    </SuiClientProvider>
  );
}
