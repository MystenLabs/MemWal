/**
 * ZKLOGIN CLIENT
 * Handles Sui network interactions and zkLogin proof generation
 *
 * NOTE: Uses direct JSON-RPC calls instead of SuiClient since @mysten/sui v2
 * removed the concrete SuiClient class.
 */

import { genAddressSeed, getZkLoginSignature, jwtToAddress, getExtendedEphemeralPublicKey } from "@mysten/zklogin";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { ZKLOGIN_CONFIG, AUTH_ERRORS } from "../constant";
import type { ZkProofData } from "@/shared/db/type";
import { decodeAndValidateJwt } from "../domain/zklogin";

// ═══════════════════════════════════════════════════════════════
// Network URL Helper
// ═══════════════════════════════════════════════════════════════

function getFullnodeUrl(network: "testnet" | "mainnet" | "devnet"): string {
  const urls = {
    testnet: "https://fullnode.testnet.sui.io:443",
    mainnet: "https://fullnode.mainnet.sui.io:443",
    devnet: "https://fullnode.devnet.sui.io:443",
  };
  return urls[network];
}

// ═══════════════════════════════════════════════════════════════
// Direct JSON-RPC helper (replaces SuiClient)
// ═══════════════════════════════════════════════════════════════

async function suiRpc(method: string, params: any[] = []) {
  const url = getFullnodeUrl(ZKLOGIN_CONFIG.network);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

/**
 * Get a SuiClient-like wrapper using JSON-RPC.
 * @mysten/sui v2 removed the concrete SuiClient class,
 * so we provide a thin wrapper with the methods used by AI tools.
 */
export function getSuiClient() {
  return {
    async getAllBalances({ owner }: { owner: string }): Promise<any> {
      return suiRpc("suix_getAllBalances", [owner]);
    },
    async queryTransactionBlocks(params: any): Promise<any> {
      return suiRpc("suix_queryTransactionBlocks", [params]);
    },
    async getOwnedObjects(params: any): Promise<any> {
      return suiRpc("suix_getOwnedObjects", [params]);
    },
    async getStakes({ owner }: { owner: string }): Promise<any> {
      return suiRpc("suix_getStakes", [owner]);
    },
    async getCoinMetadata({ coinType }: { coinType: string }): Promise<any> {
      return suiRpc("suix_getCoinMetadata", [coinType]);
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Network Information
// ═══════════════════════════════════════════════════════════════

/**
 * Get current epoch from Sui network
 */
export async function getCurrentEpoch(): Promise<number> {
  const systemState = await suiRpc("suix_getLatestSuiSystemState");
  return Number(systemState.epoch);
}

// ═══════════════════════════════════════════════════════════════
// Address Derivation
// ═══════════════════════════════════════════════════════════════

/**
 * Derive Sui address from JWT and salt
 */
export async function deriveAddress(jwt: string, salt: string): Promise<string> {
  try {
    const address = jwtToAddress(jwt, BigInt(salt), false);
    return address;
  } catch (error) {
    throw new Error("Failed to derive Sui address from JWT");
  }
}

// ═══════════════════════════════════════════════════════════════
// Salt Management
// ═══════════════════════════════════════════════════════════════

async function generateLocalSalt(jwt: string): Promise<string> {
  const claims = decodeAndValidateJwt(jwt);
  const saltString = `${claims.iss}::${claims.sub}::${claims.aud}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(saltString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer).slice(0, 16));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  const salt = BigInt('0x' + hashHex).toString();
  return salt;
}

export async function fetchUserSalt(jwt: string): Promise<string> {
  return generateLocalSalt(jwt);
}

// ═══════════════════════════════════════════════════════════════
// Zero-Knowledge Proof Generation
// ═══════════════════════════════════════════════════════════════

export type ProofGenerationParams = {
  jwt: string;
  ephemeralPublicKey: string;
  maxEpoch: number;
  randomness: string;
  salt: string;
};

export async function generateZkProof(
  params: ProofGenerationParams
): Promise<ZkProofData> {
  try {
    const jwtClaims = decodeAndValidateJwt(params.jwt);
    const publicKey = new Ed25519PublicKey(params.ephemeralPublicKey);
    const extendedPublicKey = getExtendedEphemeralPublicKey(publicKey);

    const requestBody = {
      jwt: params.jwt,
      extendedEphemeralPublicKey: extendedPublicKey,
      maxEpoch: params.maxEpoch,
      jwtRandomness: params.randomness,
      salt: params.salt,
      keyClaimName: "sub",
    };

    const response = await fetch(ZKLOGIN_CONFIG.proverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errorText = "Unknown error";
      try { errorText = await response.text(); } catch { }
      throw new Error(`Prover service returned ${response.status}: ${errorText}`);
    }

    const proofData = await response.json();

    const addressSeed = genAddressSeed(
      BigInt(params.salt),
      "sub",
      jwtClaims.sub,
      jwtClaims.aud.toString()
    ).toString();

    return {
      proof: JSON.stringify(proofData),
      addressSeed,
    };
  } catch (error) {
    console.error("[zkLogin] Failed to generate ZK proof:", error);
    throw new Error(AUTH_ERRORS.PROOF_GENERATION_FAILED);
  }
}

// ═══════════════════════════════════════════════════════════════
// Transaction Signing
// ═══════════════════════════════════════════════════════════════

export function assembleZkLoginSignature(params: {
  userSignature: string;
  zkProof: ZkProofData;
  ephemeralPublicKey: string;
  maxEpoch: number;
}): string {
  return getZkLoginSignature({
    inputs: {
      ...JSON.parse(params.zkProof.proof),
      addressSeed: params.zkProof.addressSeed,
    },
    maxEpoch: params.maxEpoch,
    userSignature: params.userSignature,
  });
}
