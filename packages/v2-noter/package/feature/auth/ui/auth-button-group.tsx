/**
 * AUTH BUTTON GROUP
 * Combined login button with dropdown for alternative auth methods
 */

"use client";

import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { ChevronDown, Loader2, Wallet } from "lucide-react";
import { useState } from "react";
import { WALLET_INSTALL_URLS, type WalletType } from "../constant";
import { useAuth } from "../hook/use-auth";
import {
  connectWallet,
  generateAuthMessage,
  isWalletInstalled,
  signMessage,
} from "../lib/wallet-client";
import { LoginButton } from "./login-button";

export function AuthButtonGroup() {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isWalletConnecting, setIsWalletConnecting] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const { connectWalletAuth, isLoginPending } = useAuth();

  const slushInstalled = isWalletInstalled("slush");

  const handleWalletSelect = async (walletType: WalletType) => {
    // If wallet not installed, open install URL
    if (!slushInstalled) {
      window.open(WALLET_INSTALL_URLS[walletType], "_blank");
      setDropdownOpen(false);
      return;
    }

    setWalletError(null);
    setIsWalletConnecting(true);
    setDropdownOpen(false);

    try {
      // 1. Connect to wallet
      const account = await connectWallet(walletType);

      // 2. Generate message to sign
      const message = generateAuthMessage();

      // 3. Sign message
      const { signature } = await signMessage(walletType, message, account);

      // 4. Authenticate with backend
      await connectWalletAuth({
        walletType,
        address: account.address,
        signature,
        message,
      });
    } catch (err) {
      console.error(`[AuthButtonGroup] Failed to connect ${walletType}:`, err);
      setWalletError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setIsWalletConnecting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-9">
        {/* Primary Button - Continue with Google */}
        <LoginButton provider="google" className="flex-1" />

        {/* Dropdown Trigger */}
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="default"
              size="icon"
              disabled={isLoginPending || isWalletConnecting}
            >
              {isWalletConnecting ? (
                <Loader2 className="h-4 w-4 animate-spinx" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Other sign-in options</DropdownMenuLabel>
            <DropdownMenuSeparator />

            {/* Wallet Options */}
            <DropdownMenuItem
              onClick={() => handleWalletSelect("slush")}
              disabled={isWalletConnecting}
              className="cursor-pointer"
            >
              {isWalletConnecting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Wallet className="mr-2 h-4 w-4" />
              )}
              <span>Slush Wallet</span>
              {!slushInstalled && (
                <span className="ml-auto text-xs text-muted-foreground">Install</span>
              )}
            </DropdownMenuItem>

            {/* Future: Add more OAuth providers here */}
            {/* <DropdownMenuSeparator />
          <DropdownMenuItem>
            <span>Facebook</span>
          </DropdownMenuItem> */}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Error Message */}
      {walletError && (
        <p className="text-xs text-destructive">{walletError}</p>
      )}
    </div>
  );
}
