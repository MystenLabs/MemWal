/**
 * Error Handling System for Personal Data Wallet SDK
 * 
 * Provides structured error types, validation, and user-friendly messages
 * for all SDK operations including blockchain, storage, and encryption errors.
 */

// ==================== BASE ERROR CLASSES ====================

/**
 * Base error class for all Personal Data Wallet SDK errors
 */
export abstract class PDWError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly severity: ErrorSeverity;
  public readonly context?: Record<string, any>;
  public readonly timestamp: Date;
  public readonly originalError?: Error;

  constructor(
    message: string,
    code: string,
    category: ErrorCategory,
    severity: ErrorSeverity = 'error',
    context?: Record<string, any>,
    originalError?: Error
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.category = category;
    this.severity = severity;
    this.context = context;
    this.timestamp = new Date();
    this.originalError = originalError;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to a structured object for logging/reporting
   */
  toObject(): ErrorObject {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
      originalError: this.originalError ? {
        name: this.originalError.name,
        message: this.originalError.message,
        stack: this.originalError.stack,
      } : undefined,
    };
  }

  /**
   * Get user-friendly error message
   */
  getUserMessage(): string {
    return ERROR_MESSAGES[this.code] || this.message;
  }

  /**
   * Check if error is retryable
   */
  isRetryable(): boolean {
    return RETRYABLE_ERROR_CODES.includes(this.code);
  }
}

// ==================== ERROR TYPES ====================

export type ErrorCategory = 
  | 'validation'
  | 'blockchain'
  | 'storage' 
  | 'encryption'
  | 'network'
  | 'configuration'
  | 'authentication'
  | 'permission';

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface ErrorObject {
  name: string;
  message: string;
  code: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  context?: Record<string, any>;
  timestamp: string;
  stack?: string;
  originalError?: {
    name: string;
    message: string;
    stack?: string;
  };
}

// ==================== VALIDATION ERRORS ====================

export class ValidationError extends PDWError {
  constructor(
    message: string,
    field?: string,
    value?: any,
    originalError?: Error
  ) {
    super(
      message,
      'VALIDATION_ERROR',
      'validation',
      'error',
      { field, value },
      originalError
    );
  }
}

export class ConfigurationError extends PDWError {
  constructor(
    message: string,
    configKey?: string,
    originalError?: Error
  ) {
    super(
      message,
      'CONFIGURATION_ERROR',
      'configuration',
      'error',
      { configKey },
      originalError
    );
  }
}

export class InvalidParameterError extends PDWError {
  constructor(parameter: string, expected: string, received: any) {
    super(
      `Invalid parameter '${parameter}': expected ${expected}, received ${typeof received}`,
      'INVALID_PARAMETER',
      'validation',
      'error',
      { field: parameter, value: received }
    );
  }
}

export class MissingParameterError extends PDWError {
  constructor(parameter: string) {
    super(
      `Missing required parameter: ${parameter}`,
      'MISSING_PARAMETER',
      'validation',
      'error',
      { field: parameter }
    );
  }
}

// ==================== BLOCKCHAIN ERRORS ====================

export class BlockchainError extends PDWError {
  constructor(
    message: string,
    code: string,
    context?: Record<string, any>,
    originalError?: Error
  ) {
    super(message, code, 'blockchain', 'error', context, originalError);
  }
}

export class TransactionError extends BlockchainError {
  constructor(
    message: string,
    transactionId?: string,
    originalError?: Error
  ) {
    super(
      message,
      'TRANSACTION_ERROR',
      { transactionId },
      originalError
    );
  }
}

export class InsufficientGasError extends BlockchainError {
  constructor(required: number, available: number) {
    super(
      `Insufficient gas: required ${required}, available ${available}`,
      'INSUFFICIENT_GAS',
      { required, available }
    );
  }
}

export class ContractExecutionError extends BlockchainError {
  constructor(
    contractFunction: string,
    reason: string,
    originalError?: Error
  ) {
    super(
      `Contract execution failed: ${contractFunction} - ${reason}`,
      'CONTRACT_EXECUTION_ERROR',
      { contractFunction, reason },
      originalError
    );
  }
}

export class ObjectNotFoundError extends BlockchainError {
  constructor(objectId: string, objectType?: string) {
    super(
      `Object not found: ${objectId}${objectType ? ` (${objectType})` : ''}`,
      'OBJECT_NOT_FOUND',
      { objectId, objectType }
    );
  }
}

// ==================== STORAGE ERRORS ====================

export class StorageError extends PDWError {
  constructor(
    message: string,
    code: string,
    context?: Record<string, any>,
    originalError?: Error
  ) {
    super(message, code, 'storage', 'error', context, originalError);
  }
}

export class WalrusError extends StorageError {
  constructor(
    message: string,
    blobId?: string,
    originalError?: Error
  ) {
    super(
      message,
      'WALRUS_ERROR',
      { blobId },
      originalError
    );
  }
}

export class StorageUploadError extends StorageError {
  constructor(
    reason: string,
    fileSize?: number,
    originalError?: Error
  ) {
    super(
      `Storage upload failed: ${reason}`,
      'STORAGE_UPLOAD_ERROR',
      { fileSize },
      originalError
    );
  }
}

export class StorageRetrievalError extends StorageError {
  constructor(
    blobId: string,
    reason: string,
    originalError?: Error
  ) {
    super(
      `Storage retrieval failed for ${blobId}: ${reason}`,
      'STORAGE_RETRIEVAL_ERROR',
      { blobId },
      originalError
    );
  }
}

export class StorageQuotaExceededError extends StorageError {
  constructor(currentUsage: number, limit: number) {
    super(
      `Storage quota exceeded: ${currentUsage}/${limit} bytes`,
      'STORAGE_QUOTA_EXCEEDED',
      { currentUsage, limit }
    );
  }
}

// ==================== ENCRYPTION ERRORS ====================

export class EncryptionError extends PDWError {
  constructor(
    message: string,
    code: string,
    context?: Record<string, any>,
    originalError?: Error
  ) {
    super(message, code, 'encryption', 'error', context, originalError);
  }
}

export class SealInitializationError extends EncryptionError {
  constructor(reason: string, originalError?: Error) {
    super(
      `SEAL client initialization failed: ${reason}`,
      'SEAL_INITIALIZATION_ERROR',
      { reason },
      originalError
    );
  }
}

export class EncryptionFailedError extends EncryptionError {
  constructor(
    userAddress: string,
    reason: string,
    originalError?: Error
  ) {
    super(
      `Encryption failed for ${userAddress}: ${reason}`,
      'ENCRYPTION_FAILED',
      { userAddress, reason },
      originalError
    );
  }
}

export class DecryptionFailedError extends EncryptionError {
  constructor(
    reason: string,
    contentId?: string,
    originalError?: Error
  ) {
    super(
      `Decryption failed: ${reason}`,
      'DECRYPTION_FAILED',
      { contentId, reason },
      originalError
    );
  }
}

export class AccessDeniedError extends EncryptionError {
  constructor(
    userAddress: string,
    contentId: string,
    reason?: string
  ) {
    super(
      `Access denied for user ${userAddress} to content ${contentId}${reason ? `: ${reason}` : ''}`,
      'ACCESS_DENIED',
      { userAddress, contentId, reason }
    );
  }
}

export class SessionKeyError extends EncryptionError {
  constructor(
    operation: string,
    reason: string,
    originalError?: Error
  ) {
    super(
      `Session key ${operation} failed: ${reason}`,
      'SESSION_KEY_ERROR',
      { operation, reason },
      originalError
    );
  }
}

// ==================== NETWORK ERRORS ====================

export class NetworkError extends PDWError {
  constructor(
    message: string,
    code: string,
    context?: Record<string, any>,
    originalError?: Error
  ) {
    super(message, code, 'network', 'error', context, originalError);
  }
}

export class ConnectionError extends NetworkError {
  constructor(endpoint: string, originalError?: Error) {
    super(
      `Failed to connect to ${endpoint}`,
      'CONNECTION_ERROR',
      { endpoint },
      originalError
    );
  }
}

export class TimeoutError extends NetworkError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `Operation '${operation}' timed out after ${timeoutMs}ms`,
      'TIMEOUT_ERROR',
      { operation, timeoutMs }
    );
  }
}

export class RateLimitError extends NetworkError {
  constructor(service: string, retryAfter?: number) {
    super(
      `Rate limit exceeded for ${service}${retryAfter ? `, retry after ${retryAfter}s` : ''}`,
      'RATE_LIMIT_ERROR',
      { service, retryAfter }
    );
  }
}

// ==================== AUTHENTICATION ERRORS ====================

export class AuthenticationError extends PDWError {
  constructor(
    message: string,
    code: string,
    context?: Record<string, any>,
    originalError?: Error
  ) {
    super(message, code, 'authentication', 'error', context, originalError);
  }
}

export class InvalidSignatureError extends AuthenticationError {
  constructor(expectedAddress: string, actualAddress?: string) {
    super(
      `Invalid signature: expected from ${expectedAddress}${actualAddress ? `, got from ${actualAddress}` : ''}`,
      'INVALID_SIGNATURE',
      { expectedAddress, actualAddress }
    );
  }
}

export class WalletNotConnectedError extends AuthenticationError {
  constructor() {
    super(
      'Wallet not connected. Please connect your wallet to continue.',
      'WALLET_NOT_CONNECTED'
    );
  }
}

// ==================== USER-FRIENDLY ERROR MESSAGES ====================

export const ERROR_MESSAGES: Record<string, string> = {
  // Validation
  'VALIDATION_ERROR': 'The provided information is invalid. Please check your input and try again.',
  'CONFIGURATION_ERROR': 'There is an issue with the SDK configuration. Please check your settings.',
  'INVALID_PARAMETER': 'One of the provided values is invalid. Please check your input.',
  'MISSING_PARAMETER': 'Required information is missing. Please provide all necessary details.',

  // Blockchain
  'TRANSACTION_ERROR': 'The blockchain transaction failed. Please try again.',
  'INSUFFICIENT_GAS': 'Not enough gas to complete the transaction. Please add more SUI to your wallet.',
  'CONTRACT_EXECUTION_ERROR': 'The smart contract operation failed. Please try again later.',
  'OBJECT_NOT_FOUND': 'The requested item could not be found on the blockchain.',

  // Storage
  'WALRUS_ERROR': 'There was an issue with decentralized storage. Please try again.',
  'STORAGE_UPLOAD_ERROR': 'Failed to save your data. Please check your connection and try again.',
  'STORAGE_RETRIEVAL_ERROR': 'Failed to retrieve your data. Please try again later.',
  'STORAGE_QUOTA_EXCEEDED': 'You have reached your storage limit. Please free up space or upgrade your plan.',

  // Encryption
  'SEAL_INITIALIZATION_ERROR': 'Encryption service is currently unavailable. Please try again later.',
  'ENCRYPTION_FAILED': 'Failed to encrypt your data. Please try again.',
  'DECRYPTION_FAILED': 'Failed to decrypt the requested content. Please check your permissions.',
  'ACCESS_DENIED': 'You do not have permission to access this content.',
  'SESSION_KEY_ERROR': 'Authentication session expired. Please reconnect and try again.',

  // Network
  'CONNECTION_ERROR': 'Unable to connect to the service. Please check your internet connection.',
  'TIMEOUT_ERROR': 'The operation took too long to complete. Please try again.',
  'RATE_LIMIT_ERROR': 'Too many requests. Please wait a moment before trying again.',

  // Authentication
  'INVALID_SIGNATURE': 'The signature verification failed. Please sign the transaction again.',
  'WALLET_NOT_CONNECTED': 'Please connect your wallet to use this feature.',
};

// ==================== RETRYABLE ERROR CODES ====================

export const RETRYABLE_ERROR_CODES = [
  'CONNECTION_ERROR',
  'TIMEOUT_ERROR',
  'WALRUS_ERROR',
  'STORAGE_RETRIEVAL_ERROR',
  'NETWORK_ERROR',
  'SEAL_INITIALIZATION_ERROR',
];

// ==================== ERROR UTILITIES ====================

/**
 * Check if an error is a PDW SDK error
 */
export function isPDWError(error: any): error is PDWError {
  return error instanceof PDWError;
}

/**
 * Wrap unknown errors in a PDWError
 */
export function wrapError(
  error: unknown,
  category: ErrorCategory = 'unknown' as ErrorCategory,
  context?: Record<string, any>
): PDWError {
  if (isPDWError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new ValidationError(
      error.message,
      undefined,
      undefined,
      error
    );
  }

  return new ValidationError(
    'An unknown error occurred',
    undefined,
    error
  );
}

/**
 * Create error from Sui/blockchain errors
 */
export function createBlockchainError(error: any, context?: Record<string, any>): BlockchainError {
  const message = error?.message || 'Unknown blockchain error';
  
  // Check for specific Sui error patterns
  if (message.includes('InsufficientGas')) {
    const gasMatch = message.match(/required: (\d+), available: (\d+)/);
    if (gasMatch) {
      return new InsufficientGasError(parseInt(gasMatch[1]), parseInt(gasMatch[2]));
    }
    return new InsufficientGasError(0, 0);
  }

  if (message.includes('ObjectNotExists') || message.includes('not found')) {
    const objectId = context?.objectId || 'unknown';
    return new ObjectNotFoundError(objectId);
  }

  if (message.includes('execution_failure') || message.includes('MoveAbort')) {
    return new ContractExecutionError(
      context?.function || 'unknown',
      message,
      error
    );
  }

  return new BlockchainError(message, 'BLOCKCHAIN_ERROR', context, error);
}

/**
 * Create error from network/HTTP errors
 */
export function createNetworkError(error: any, endpoint?: string): NetworkError {
  const message = error?.message || 'Network error occurred';

  if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') {
    return new ConnectionError(endpoint || 'unknown endpoint', error);
  }

  if (error?.code === 'TIMEOUT' || message.includes('timeout')) {
    return new TimeoutError('network request', error?.timeout || 30000);
  }

  if (error?.status === 429 || message.includes('rate limit')) {
    return new RateLimitError(endpoint || 'unknown service', error?.retryAfter);
  }

  return new NetworkError(message, 'NETWORK_ERROR', { endpoint }, error);
}

// Re-export validation utilities
export * from './validation';

// Re-export recovery utilities
export * from './recovery';