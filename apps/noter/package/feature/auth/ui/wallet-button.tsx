/**
 * WALLET BUTTON COMPONENT
 * Triggers wallet connection (Slush, Sui Wallet)
 */

"use client";

import { Button } from "@/shared/components/ui/button";
import { useAuth } from "../hook/use-auth";
import { Loader2, Wallet } from "lucide-react";
import { useState } from "react";
import {
  connectWallet,
  signMessage,
  isWalletInstalled,
} from "../lib/wallet-client";
import { trpc } from "@/shared/lib/trpc/client";
import { WALLET_NAMES, WALLET_INSTALL_URLS, type WalletType } from "../constant";

export type WalletButtonProps = {
  wallet: WalletType;
  className?: string;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
};

export function WalletButton({
  wallet,
  className,
  variant = "outline",
  size = "default",
}: WalletButtonProps) {
  const { connectWalletAuth, isLoginPending } = useAuth();
  const getChallenge = trpc.auth.getChallenge.useMutation();
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const walletName = WALLET_NAMES[wallet];
  const installed = isWalletInstalled(wallet);

  const handleConnect = async () => {
    setError(null);
    setIsConnecting(true);

    try {
      // 1. Connect to wallet
      const account = await connectWallet(wallet);

      // 2. Get server-issued challenge nonce
      const { challengeId, nonce } = await getChallenge.mutateAsync();

      // 3. Sign the challenge nonce
      const { signature } = await signMessage(wallet, nonce, account);

      // 4. Authenticate with backend
      await connectWalletAuth({
        walletType: wallet,
        address: account.address,
        signature,
        challengeId,
      });    } catch (err) {
      console.error(`[WalletButton] Failed to connect ${wallet}:`, err);
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setIsConnecting(false);
    }
  };

  const handleInstall = () => {
    window.open(WALLET_INSTALL_URLS[wallet], "_blank");
  };

  if (!installed) {
    return (
      <Button
        onClick={handleInstall}
        variant={variant}
        size={size}
        className={className}
      >
        <Wallet className="mr-2 h-4 w-4" />
        Install {walletName}
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        onClick={handleConnect}
        disabled={isConnecting || isLoginPending}
        variant={variant}
        size={size}
        className={className}
      >
        {isConnecting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Connecting...
          </>
        ) : (
          <>
            <Wallet className="mr-2 h-4 w-4" />
            {walletName}
          </>
        )}
      </Button>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
