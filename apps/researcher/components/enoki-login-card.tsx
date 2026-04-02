"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  useWallets,
  useConnectWallet,
  useCurrentAccount,
  useSignTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { isEnokiWallet } from "@mysten/enoki";
import { Transaction } from "@mysten/sui/transactions";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { enokiConfig } from "@/lib/enoki/config";

type Step =
  | "idle"
  | "connecting"
  | "generating-key"
  | "registering-onchain"
  | "creating-session"
  | "done";

const STEP_LABELS: Record<Step, string> = {
  idle: "",
  connecting: "Signing in with Google...",
  "generating-key": "Generating delegate key...",
  "registering-onchain": "Registering on-chain...",
  "creating-session": "Creating session...",
  done: "Redirecting...",
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function sponsoredSignAndExecute(
  transaction: Transaction,
  sender: string,
  suiClient: ReturnType<typeof useSuiClient>,
  signTransaction: (args: {
    transaction: Transaction;
  }) => Promise<{ signature: string }>,
): Promise<{ digest: string }> {
  const kindBytes = await transaction.build({
    client: suiClient as any,
    onlyTransactionKind: true,
  });

  const sponsorRes = await fetch(
    `${enokiConfig.memwalServerUrl}/sponsor`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transactionBlockKindBytes: uint8ArrayToBase64(kindBytes),
        sender,
      }),
    },
  );

  if (!sponsorRes.ok) {
    const errText = await sponsorRes.text();
    throw new Error(`Sponsor failed (${sponsorRes.status}): ${errText}`);
  }

  const sponsored = await sponsorRes.json();
  const sponsoredTx = Transaction.from(sponsored.bytes);
  const { signature } = await signTransaction({ transaction: sponsoredTx });

  const execRes = await fetch(
    `${enokiConfig.memwalServerUrl}/sponsor/execute`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest: sponsored.digest, signature }),
    },
  );

  if (!execRes.ok) {
    const errText = await execRes.text();
    throw new Error(
      `Sponsored execute failed (${execRes.status}): ${errText}`,
    );
  }

  return execRes.json();
}

export function EnokiLoginCard() {
  const router = useRouter();
  const wallets = useWallets();
  const { mutateAsync: connect } = useConnectWallet();
  const currentAccount = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signTransaction } = useSignTransaction();

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState("");
  const setupRunningRef = useRef(false);

  const enokiWallets = wallets.filter(isEnokiWallet);
  const googleWallet = enokiWallets.find((w) => w.provider === "google");
  const hasEnokiConfig =
    enokiConfig.enokiApiKey &&
    enokiConfig.googleClientId &&
    enokiConfig.memwalPackageId &&
    enokiConfig.memwalRegistryId &&
    enokiConfig.memwalServerUrl;

  const [pendingSetup, setPendingSetup] = useState(false);

  const runSetup = useCallback(
    async (address: string) => {
      // Prevent double-run
      if (setupRunningRef.current) return;
      setupRunningRef.current = true;

      try {
        // Phase 1: Check if returning user with stored credentials
        setStep("creating-session");
        const checkRes = await fetch("/api/auth/enoki", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suiAddress: address }),
        });

        if (!checkRes.ok) {
          // Server error — don't silently fall through to Phase 2
          throw new Error("Unable to check account status. Please try again.");
        }

        const checkData = await checkRes.json();
        if (!checkData.needsSetup) {
          // Returning user — session created from stored credentials
          setStep("done");
          router.push("/");
          router.refresh();
          return;
        }

        // Phase 2: First-time user — generate key + register on-chain
        // Step: Generate delegate keypair
        setStep("generating-key");
        const ed = await import("@noble/ed25519");
        const { blake2b } = await import("@noble/hashes/blake2b");

        const privateKeyRaw = new Uint8Array(32);
        crypto.getRandomValues(privateKeyRaw);
        const publicKeyRaw = await ed.getPublicKeyAsync(privateKeyRaw);

        const privateKeyHex = bytesToHex(privateKeyRaw);
        const publicKeyHex = bytesToHex(publicKeyRaw);

        // Derive Sui address for delegate key: blake2b256(0x00 || pubkey)
        const addrInput = new Uint8Array(33);
        addrInput[0] = 0x00; // Ed25519 scheme flag
        addrInput.set(publicKeyRaw, 1);
        const addressBytes = blake2b(addrInput, { dkLen: 32 });
        const delegateSuiAddress =
          "0x" + bytesToHex(new Uint8Array(addressBytes));

        // Step: On-chain registration
        setStep("registering-onchain");

        let knownAccountId: string | null = null;

        // Check if MemWal account already exists for this address
        try {
          const registryObj = await suiClient.getObject({
            id: enokiConfig.memwalRegistryId,
            options: { showContent: true },
          });
          if (
            registryObj?.data?.content &&
            "fields" in registryObj.data.content
          ) {
            const fields = registryObj.data.content.fields as any;
            const tableId = fields?.accounts?.fields?.id?.id;
            if (tableId) {
              const dynField = await suiClient.getDynamicFieldObject({
                parentId: tableId,
                name: { type: "address", value: address },
              });
              if (
                dynField?.data?.content &&
                "fields" in dynField.data.content
              ) {
                knownAccountId = (dynField.data.content.fields as any)
                  .value as string;
              }
            }
          }
        } catch {
          // Dynamic field not found → no account yet
        }

        const pubKeyBytes = Array.from(publicKeyRaw);

        const sign = (args: { transaction: Transaction }) =>
          signTransaction(args);

        if (knownAccountId) {
          // Account exists — add delegate key
          const tx = new Transaction();
          tx.moveCall({
            target: `${enokiConfig.memwalPackageId}::account::add_delegate_key`,
            arguments: [
              tx.object(knownAccountId),
              tx.pure("vector<u8>", pubKeyBytes),
              tx.pure("address", delegateSuiAddress),
              tx.pure("string", "Researcher"),
              tx.object("0x6"),
            ],
          });
          const result = await sponsoredSignAndExecute(
            tx,
            address,
            suiClient,
            sign,
          );
          await suiClient.waitForTransaction({ digest: result.digest });
        } else {
          // Create account first
          const tx = new Transaction();
          tx.moveCall({
            target: `${enokiConfig.memwalPackageId}::account::create_account`,
            arguments: [
              tx.object(enokiConfig.memwalRegistryId),
              tx.object("0x6"),
            ],
          });
          const createResult = await sponsoredSignAndExecute(
            tx,
            address,
            suiClient,
            sign,
          );
          await suiClient.waitForTransaction({
            digest: createResult.digest,
          });

          // Find the created account object
          const txDetails = await suiClient.getTransactionBlock({
            digest: createResult.digest,
            options: { showObjectChanges: true },
          });
          const createdObj = txDetails.objectChanges?.find(
            (c) =>
              c.type === "created" &&
              "objectType" in c &&
              c.objectType.includes("MemWalAccount"),
          );
          if (createdObj && "objectId" in createdObj) {
            knownAccountId = createdObj.objectId;
          }

          if (!knownAccountId) {
            throw new Error(
              "Account created on-chain but object ID not found in transaction. Please try again.",
            );
          }

          // Add delegate key
          const tx2 = new Transaction();
          tx2.moveCall({
            target: `${enokiConfig.memwalPackageId}::account::add_delegate_key`,
            arguments: [
              tx2.object(knownAccountId!),
              tx2.pure("vector<u8>", pubKeyBytes),
              tx2.pure("address", delegateSuiAddress),
              tx2.pure("string", "Researcher"),
              tx2.object("0x6"),
            ],
          });
          const addResult = await sponsoredSignAndExecute(
            tx2,
            address,
            suiClient,
            sign,
          );
          await suiClient.waitForTransaction({ digest: addResult.digest });
        }

        // Step: Create server session + store credentials for returning login
        setStep("creating-session");
        const res = await fetch("/api/auth/enoki", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            suiAddress: address,
            privateKey: privateKeyHex,
            accountId: knownAccountId!,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Session creation failed");
        }

        setStep("done");
        router.push("/");
        router.refresh();
      } catch (err) {
        console.error("[enoki-login] Setup failed:", err);
        setError(
          err instanceof Error
            ? err.message
            : "Setup failed. Please try again.",
        );
        setStep("idle");
      } finally {
        setupRunningRef.current = false;
      }
    },
    [suiClient, signTransaction, router],
  );

  // When wallet connects after Google OAuth, continue the setup
  useEffect(() => {
    if (pendingSetup && currentAccount?.address) {
      setPendingSetup(false);
      runSetup(currentAccount.address);
    }
  }, [pendingSetup, currentAccount?.address, runSetup]);

  const handleGoogleSignIn = async () => {
    if (!googleWallet) return;

    setError("");
    setStep("connecting");

    try {
      await connect({ wallet: googleWallet });
      // connect() resolves but currentAccount may not be updated yet in this
      // render cycle. Set pendingSetup so the useEffect picks it up.
      setPendingSetup(true);
    } catch (err) {
      console.error("[enoki-login] Connect failed:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Google sign-in failed. Please try again.",
      );
      setStep("idle");
    }
  };

  if (!hasEnokiConfig || !googleWallet) return null;

  const isProcessing = step !== "idle";

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <Button
        className="w-full"
        disabled={isProcessing}
        onClick={handleGoogleSignIn}
        size="lg"
        variant="outline"
      >
        {isProcessing ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {STEP_LABELS[step]}
          </>
        ) : (
          <>
            <svg className="size-4" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Sign in with Google
          </>
        )}
      </Button>

      {error && (
        <p className="mt-3 text-center text-destructive text-sm">{error}</p>
      )}
    </div>
  );
}
