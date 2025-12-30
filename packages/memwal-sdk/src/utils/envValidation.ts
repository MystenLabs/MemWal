/**
 * Environment Variable Validation for MemWal SDK
 * 
 * Validates required environment variables at runtime to fail fast
 * with helpful error messages rather than failing mysteriously later.
 */

import { z } from 'zod';
import { ConfigurationError } from '../errors';

/**
 * Schema for SDK environment variables
 */
export const SDKEnvSchema = z.object({
  // Sui Network Configuration
  SUI_NETWORK: z.enum(['mainnet', 'testnet', 'devnet', 'localnet']).optional(),
  PACKAGE_ID: z.string().regex(/^0x[a-f0-9]+$/i, 'Invalid package ID format').optional(),
  
  // API Keys
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  
  // Walrus Configuration
  WALRUS_PUBLISHER: z.string().url().optional(),
  WALRUS_AGGREGATOR: z.string().url().optional(),
  
  // SEAL Encryption
  SEAL_KEY_SERVER_URL: z.string().url().optional(),
  SEAL_NETWORK: z.enum(['mainnet', 'testnet', 'devnet']).optional(),
  SEAL_KEY_SERVER_1: z.string().optional(),
  SEAL_KEY_SERVER_2: z.string().optional(),
  
  // Sui Wallet (for backend)
  SUI_PRIVATE_KEY: z.string().optional(),
  WALLET_ADDRESS: z.string().optional(),
  
  // Memory Index
  MEMORY_INDEX_ID: z.string().optional(),
  INDEX_BLOB_ID: z.string().optional(),
  GRAPH_BLOB_ID: z.string().optional(),
});

/**
 * Schema for Next.js public environment variables
 */
export const NextPublicEnvSchema = z.object({
  NEXT_PUBLIC_PACKAGE_ID: z.string().regex(/^0x[a-f0-9]+$/i, 'Invalid package ID format').optional(),
  NEXT_PUBLIC_SUI_NETWORK: z.enum(['mainnet', 'testnet', 'devnet', 'localnet']).optional(),
  NEXT_PUBLIC_WALRUS_AGGREGATOR: z.string().url().optional(),
  NEXT_PUBLIC_WALRUS_PUBLISHER: z.string().url().optional(),
});

/**
 * Validation result
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

/**
 * Validate environment variables against schema
 */
export function validateEnv<T extends z.ZodSchema>(
  schema: T,
  env: Record<string, any> = process.env
): ValidationResult<z.infer<T>> {
  try {
    const data = schema.parse(env);
    return {
      success: true,
      data,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors: ValidationError[] = error.errors.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
        value: err.code === 'invalid_type' ? undefined : env[err.path[0]],
      }));
      
      return {
        success: false,
        errors,
      };
    }
    
    return {
      success: false,
      errors: [{
        field: 'unknown',
        message: error instanceof Error ? error.message : 'Unknown validation error',
      }],
    };
  }
}

/**
 * Validate and throw if invalid
 */
export function validateEnvOrThrow<T extends z.ZodSchema>(
  schema: T,
  env: Record<string, any> = process.env,
  context?: string
): z.infer<T> {
  const result = validateEnv(schema, env);
  
  if (!result.success) {
    const errorMessages = result.errors!.map(
      (err) => `  - ${err.field}: ${err.message}`
    ).join('\n');
    
    throw new ConfigurationError(
      `Environment validation failed${context ? ` for ${context}` : ''}:\n${errorMessages}`
    );
  }
  
  return result.data!;
}

/**
 * Check if required variables are present for a feature
 */
export interface FeatureRequirements {
  name: string;
  required: string[];
  optional?: string[];
}

export function checkFeatureRequirements(
  requirements: FeatureRequirements,
  env: Record<string, any> = process.env
): {
  available: boolean;
  missing: string[];
  present: string[];
} {
  const missing: string[] = [];
  const present: string[] = [];
  
  for (const key of requirements.required) {
    if (env[key]) {
      present.push(key);
    } else {
      missing.push(key);
    }
  }
  
  return {
    available: missing.length === 0,
    missing,
    present,
  };
}

/**
 * Get helpful error message for missing feature requirements
 */
export function getFeatureRequirementError(
  requirements: FeatureRequirements,
  env: Record<string, any> = process.env
): string | null {
  const check = checkFeatureRequirements(requirements, env);
  
  if (check.available) {
    return null;
  }
  
  const missingVars = check.missing.join(', ');
  return `Feature "${requirements.name}" is not available. Missing environment variables: ${missingVars}`;
}

/**
 * Predefined feature requirements
 */
export const FeatureRequirements = {
  EMBEDDING: {
    name: 'AI Embedding',
    required: ['GEMINI_API_KEY'],
  } as FeatureRequirements,
  
  BLOCKCHAIN: {
    name: 'Blockchain Integration',
    required: ['PACKAGE_ID', 'SUI_NETWORK'],
  } as FeatureRequirements,
  
  WALLET: {
    name: 'Wallet Operations',
    required: ['SUI_PRIVATE_KEY', 'WALLET_ADDRESS'],
  } as FeatureRequirements,
  
  WALRUS: {
    name: 'Walrus Storage',
    required: ['WALRUS_PUBLISHER', 'WALRUS_AGGREGATOR'],
  } as FeatureRequirements,
  
  SEAL: {
    name: 'SEAL Encryption',
    required: ['SEAL_KEY_SERVER_URL', 'SEAL_NETWORK'],
  } as FeatureRequirements,
  
  MEMORY_INDEX: {
    name: 'Memory Index',
    required: ['MEMORY_INDEX_ID'],
  } as FeatureRequirements,
};

/**
 * Validate minimum requirements for SDK usage
 */
export function validateMinimumRequirements(
  env: Record<string, any> = process.env
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check for at least one embedding provider
  if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY && !env.OPENROUTER_API_KEY) {
    warnings.push('No AI embedding provider configured. AI features will not be available.');
  }
  
  // Check blockchain config if wallet is present
  if (env.SUI_PRIVATE_KEY && !env.PACKAGE_ID) {
    errors.push('SUI_PRIVATE_KEY is set but PACKAGE_ID is missing');
  }
  
  // Check Walrus config consistency
  const hasWalrusPublisher = !!env.WALRUS_PUBLISHER;
  const hasWalrusAggregator = !!env.WALRUS_AGGREGATOR;
  if (hasWalrusPublisher !== hasWalrusAggregator) {
    warnings.push('Walrus configuration incomplete. Both WALRUS_PUBLISHER and WALRUS_AGGREGATOR should be set.');
  }
  
  // Check SEAL config consistency
  const hasSealUrl = !!env.SEAL_KEY_SERVER_URL;
  const hasSealNetwork = !!env.SEAL_NETWORK;
  if (hasSealUrl !== hasSealNetwork) {
    warnings.push('SEAL configuration incomplete. Both SEAL_KEY_SERVER_URL and SEAL_NETWORK should be set.');
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Get environment variable with fallback
 */
export function getEnvVar(
  key: string,
  fallback?: string,
  env: Record<string, any> = process.env
): string | undefined {
  return env[key] || fallback;
}

/**
 * Get required environment variable or throw
 */
export function getRequiredEnvVar(
  key: string,
  env: Record<string, any> = process.env
): string {
  const value = env[key];
  if (!value) {
    throw new ConfigurationError(`Required environment variable ${key} is not set`);
  }
  return value;
}
