"use client";

import { useEffect } from "react";
import {
  createNetworkConfig,
  SuiClientProvider,
  WalletProvider,
  useSuiClientContext,
} from "@mysten/dapp-kit";
import { isEnokiNetwork, registerEnokiWallets } from "@mysten/enoki";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  getJsonRpcFullnodeUrl,
  SuiJsonRpcClient,
  type SuiJsonRpcClientOptions,
} from "@mysten/sui/jsonRpc";
import { enokiConfig } from "@/lib/enoki/config";

const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" },
  mainnet: { url: getJsonRpcFullnodeUrl("mainnet"), network: "mainnet" },
});

function createClientForNetwork(name: string, options: SuiJsonRpcClientOptions) {
  if (name === enokiConfig.suiNetwork && enokiConfig.suiGrpcUrl) {
    return new SuiGrpcClient({
      network: name,
      baseUrl: enokiConfig.suiGrpcUrl,
    }) as unknown as SuiJsonRpcClient;
  }
  return new SuiJsonRpcClient(options);
}

/** Registers Enoki wallets (Google OAuth) with dapp-kit on mount. No-op if env vars are missing. */
function RegisterEnokiWallets() {
  const { client, network } = useSuiClientContext();

  useEffect(() => {
    if (!isEnokiNetwork(network)) return;
    if (!enokiConfig.enokiApiKey || !enokiConfig.googleClientId) return;

    const { unregister } = registerEnokiWallets({
      apiKey: enokiConfig.enokiApiKey,
      providers: {
        google: { clientId: enokiConfig.googleClientId },
      },
      client,
      network,
    });

    return unregister;
  }, [client, network]);

  return null;
}

/** Sui + Enoki provider stack. Does NOT include React Query — noter's TRPCProvider handles that. */
export function SuiProviders({ children }: { children: React.ReactNode }) {
  return (
    <SuiClientProvider
      networks={networkConfig}
      defaultNetwork={enokiConfig.suiNetwork}
      createClient={createClientForNetwork}
    >
      <RegisterEnokiWallets />
      <WalletProvider autoConnect>{children}</WalletProvider>
    </SuiClientProvider>
  );
}
