/**
 * WALLET SIGNATURE VERIFICATION
 *
 * Utilities for verifying wallet signatures from Sui wallets.
 * Used during wallet-based authentication to ensure the user owns the wallet.
 */

import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

/**
 * Verify a wallet signature against a message and address
 *
 * @param message - The original message that was signed
 * @param signature - The signature from the wallet
 * @param address - The wallet address to verify against
 * @returns Promise<boolean> - true if signature is valid, false otherwise
 *
 * @example
 * const isValid = await verifyWalletSignature(
 *   "Sign in to Noter",
 *   signature,
 *   walletAddress
 * );
 *
 * Note: Server-side signature verification requires additional setup.
 * For production, implement proper verification using @mysten/sui/verify.
 */
export async function verifyWalletSignature(
  message: string,
  signature: string,
  address: string
): Promise<boolean> {
  try {
    const messageBytes = new TextEncoder().encode(message);
    await verifyPersonalMessageSignature(messageBytes, signature);
    return true;
  } catch (error) {
    console.error("Signature verification failed:", error);
    return false;
  }
}
