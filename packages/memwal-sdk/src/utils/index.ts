/**
 * Utilities Module - Barrel Export
 * 
 * Central location for utility functions and helpers.
 * Currently empty - ready for future utility additions.
 * 
 * Recommended structure:
 * - utils/crypto/ - Cryptographic helpers
 * - utils/encoding/ - Encoding/decoding utilities
 * - utils/validation/ - Input validation (see errors/validation.ts)
 * - utils/formatting/ - Data formatting utilities
 * - utils/network/ - Network/HTTP helpers
 * 
 * Note: Configuration utilities are in src/config/
 * Note: Validation utilities are in src/errors/validation.ts
 */

// Re-export commonly used validation utilities for convenience
export {
  isString,
  isNumber,
  isBoolean,
  isObject,
  isArray,
  isUint8Array,
  isValidAddress,
  isValidObjectId,
  validateRequired,
  validateString,
  validateNumber,
  validateBoolean,
  validateObject,
  validateArray,
  validateSuiAddress,
  validateObjectId,
} from '../errors/validation';

// Re-export configuration helpers for convenience
export {
  ConfigurationHelper,
  type SDKConfig,
  type EnvironmentConfig,
} from '../config/ConfigurationHelper';

// Rebuild index utility for re-indexing existing memories (Browser)
export {
  rebuildIndex,
  hasExistingIndex,
  clearIndex,
  type RebuildIndexOptions,
  type RebuildIndexResult,
} from './rebuildIndex';

// Rebuild index utility for Node.js environments
export {
  rebuildIndexNode,
  hasExistingIndexNode,
  clearIndexNode,
  type RebuildIndexNodeOptions,
  type RebuildIndexNodeResult,
} from './rebuildIndexNode';

// Structured logging utility
export {
  Logger,
  LogLevel,
  configureLogger,
  createLogger,
  logger,
  LogFormatters,
  type LoggerConfig,
  type LogEntry,
  type LogFormatter,
} from './logger';

// Environment validation utility
export {
  validateEnv,
  validateEnvOrThrow,
  checkFeatureRequirements,
  getFeatureRequirementError,
  validateMinimumRequirements,
  getEnvVar,
  getRequiredEnvVar,
  SDKEnvSchema,
  NextPublicEnvSchema,
  FeatureRequirements,
  type ValidationResult,
  type ValidationError,
  type FeatureRequirements as FeatureRequirementsType,
} from './envValidation';

// Future utility exports will go here
// export * from './crypto';
// export * from './encoding';
// export * from './formatting';
// export * from './network';

