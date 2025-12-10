/**
 * Validation Utilities for Personal Data Wallet SDK
 * 
 * Provides input validation, type checking, and data sanitization
 * with automatic error throwing using the error handling system.
 */

import {
  ValidationError,
  InvalidParameterError,
  MissingParameterError,
  ConfigurationError,
} from './index';

// ==================== TYPE GUARDS ====================

export function isString(value: any): value is string {
  return typeof value === 'string';
}

export function isNumber(value: any): value is number {
  return typeof value === 'number' && !isNaN(value);
}

export function isBoolean(value: any): value is boolean {
  return typeof value === 'boolean';
}

export function isObject(value: any): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isArray(value: any): value is any[] {
  return Array.isArray(value);
}

export function isUint8Array(value: any): value is Uint8Array {
  return value instanceof Uint8Array;
}

export function isValidAddress(address: string): boolean {
  // Sui address validation - should start with 0x and be 64 characters total
  return /^0x[a-fA-F0-9]{64}$/.test(address);
}

export function isValidObjectId(objectId: string): boolean {
  // Sui object ID validation
  return /^0x[a-fA-F0-9]{64}$/.test(objectId);
}

export function isValidPackageId(packageId: string): boolean {
  // Same format as object ID
  return isValidObjectId(packageId);
}

export function isValidBlobId(blobId: string): boolean {
  // Walrus blob ID validation - alphanumeric string
  return /^[a-zA-Z0-9_-]{1,64}$/.test(blobId);
}

export function isValidCategory(category: string): boolean {
  // Memory category validation
  const validCategories = [
    'personal', 'work', 'learning', 'health', 'finance', 
    'travel', 'relationships', 'hobbies', 'goals', 'general'
  ];
  return validCategories.includes(category.toLowerCase());
}

export function isValidImportance(importance: number): boolean {
  return isNumber(importance) && importance >= 1 && importance <= 10;
}

// ==================== VALIDATION FUNCTIONS ====================

/**
 * Validate required parameter exists and is not null/undefined
 */
export function validateRequired<T>(
  value: T | null | undefined,
  parameterName: string
): T {
  if (value === null || value === undefined) {
    throw new MissingParameterError(parameterName);
  }
  return value;
}

/**
 * Validate parameter is a non-empty string
 */
export function validateString(
  value: any,
  parameterName: string,
  options?: {
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
  }
): string {
  if (options?.required !== false) {
    validateRequired(value, parameterName);
  }

  if (value === null || value === undefined) {
    if (options?.required === false) {
      return '';
    }
    throw new MissingParameterError(parameterName);
  }

  if (!isString(value)) {
    throw new InvalidParameterError(parameterName, 'string', value);
  }

  if (options?.minLength && value.length < options.minLength) {
    throw new ValidationError(
      `Parameter '${parameterName}' must be at least ${options.minLength} characters long`,
      parameterName,
      value
    );
  }

  if (options?.maxLength && value.length > options.maxLength) {
    throw new ValidationError(
      `Parameter '${parameterName}' must be no more than ${options.maxLength} characters long`,
      parameterName,
      value
    );
  }

  if (options?.pattern && !options.pattern.test(value)) {
    throw new ValidationError(
      `Parameter '${parameterName}' does not match required pattern`,
      parameterName,
      value
    );
  }

  return value;
}

/**
 * Validate parameter is a valid number
 */
export function validateNumber(
  value: any,
  parameterName: string,
  options?: {
    required?: boolean;
    min?: number;
    max?: number;
    integer?: boolean;
  }
): number {
  if (options?.required !== false) {
    validateRequired(value, parameterName);
  }

  if (value === null || value === undefined) {
    if (options?.required === false) {
      return 0;
    }
    throw new MissingParameterError(parameterName);
  }

  if (!isNumber(value)) {
    throw new InvalidParameterError(parameterName, 'number', value);
  }

  if (options?.integer && !Number.isInteger(value)) {
    throw new ValidationError(
      `Parameter '${parameterName}' must be an integer`,
      parameterName,
      value
    );
  }

  if (options?.min !== undefined && value < options.min) {
    throw new ValidationError(
      `Parameter '${parameterName}' must be at least ${options.min}`,
      parameterName,
      value
    );
  }

  if (options?.max !== undefined && value > options.max) {
    throw new ValidationError(
      `Parameter '${parameterName}' must be no more than ${options.max}`,
      parameterName,
      value
    );
  }

  return value;
}

/**
 * Validate parameter is a boolean
 */
export function validateBoolean(
  value: any,
  parameterName: string,
  required = true
): boolean {
  if (required) {
    validateRequired(value, parameterName);
  }

  if (value === null || value === undefined) {
    if (!required) {
      return false;
    }
    throw new MissingParameterError(parameterName);
  }

  if (!isBoolean(value)) {
    throw new InvalidParameterError(parameterName, 'boolean', value);
  }

  return value;
}

/**
 * Validate parameter is an object
 */
export function validateObject<T extends Record<string, any>>(
  value: any,
  parameterName: string,
  required = true
): T {
  if (required) {
    validateRequired(value, parameterName);
  }

  if (value === null || value === undefined) {
    if (!required) {
      return {} as T;
    }
    throw new MissingParameterError(parameterName);
  }

  if (!isObject(value)) {
    throw new InvalidParameterError(parameterName, 'object', value);
  }

  return value as T;
}

/**
 * Validate parameter is an array
 */
export function validateArray<T>(
  value: any,
  parameterName: string,
  options?: {
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    itemValidator?: (item: any, index: number) => T;
  }
): T[] {
  if (options?.required !== false) {
    validateRequired(value, parameterName);
  }

  if (value === null || value === undefined) {
    if (options?.required === false) {
      return [];
    }
    throw new MissingParameterError(parameterName);
  }

  if (!isArray(value)) {
    throw new InvalidParameterError(parameterName, 'array', value);
  }

  if (options?.minLength && value.length < options.minLength) {
    throw new ValidationError(
      `Parameter '${parameterName}' must have at least ${options.minLength} items`,
      parameterName,
      value
    );
  }

  if (options?.maxLength && value.length > options.maxLength) {
    throw new ValidationError(
      `Parameter '${parameterName}' must have no more than ${options.maxLength} items`,
      parameterName,
      value
    );
  }

  if (options?.itemValidator) {
    return value.map((item, index) => {
      try {
        return options.itemValidator!(item, index);
      } catch (error) {
        throw new ValidationError(
          `Invalid item at index ${index} in ${parameterName}: ${error instanceof Error ? error.message : 'unknown error'}`,
          `${parameterName}[${index}]`,
          item
        );
      }
    });
  }

  return value;
}

// ==================== DOMAIN-SPECIFIC VALIDATORS ====================

/**
 * Validate Sui address format
 */
export function validateSuiAddress(
  address: any,
  parameterName: string,
  required = true
): string {
  const addressStr = validateString(address, parameterName, { required });
  
  if (!addressStr && !required) {
    return '';
  }

  if (!isValidAddress(addressStr)) {
    throw new ValidationError(
      `Parameter '${parameterName}' must be a valid Sui address (0x followed by 64 hex characters)`,
      parameterName,
      address
    );
  }

  return addressStr;
}

/**
 * Validate Sui object ID format
 */
export function validateObjectId(
  objectId: any,
  parameterName: string,
  required = true
): string {
  const idStr = validateString(objectId, parameterName, { required });
  
  if (!idStr && !required) {
    return '';
  }

  if (!isValidObjectId(idStr)) {
    throw new ValidationError(
      `Parameter '${parameterName}' must be a valid Sui object ID (0x followed by 64 hex characters)`,
      parameterName,
      objectId
    );
  }

  return idStr;
}

/**
 * Validate memory category
 */
export function validateMemoryCategory(
  category: any,
  parameterName = 'category',
  required = true
): string {
  const categoryStr = validateString(category, parameterName, { required });
  
  if (!categoryStr && !required) {
    return 'general';
  }

  if (!isValidCategory(categoryStr)) {
    throw new ValidationError(
      `Parameter '${parameterName}' must be a valid memory category`,
      parameterName,
      category
    );
  }

  return categoryStr.toLowerCase();
}

/**
 * Validate memory importance (1-10)
 */
export function validateMemoryImportance(
  importance: any,
  parameterName = 'importance',
  required = false
): number {
  if (!required && (importance === null || importance === undefined)) {
    return 5; // Default importance
  }

  const importanceNum = validateNumber(importance, parameterName, {
    required,
    min: 1,
    max: 10,
    integer: true,
  });

  return importanceNum;
}

/**
 * Validate Walrus blob ID format
 */
export function validateBlobId(
  blobId: any,
  parameterName: string,
  required = true
): string {
  const blobIdStr = validateString(blobId, parameterName, { required });
  
  if (!blobIdStr && !required) {
    return '';
  }

  if (!isValidBlobId(blobIdStr)) {
    throw new ValidationError(
      `Parameter '${parameterName}' must be a valid Walrus blob ID`,
      parameterName,
      blobId
    );
  }

  return blobIdStr;
}

/**
 * Validate access level
 */
export function validateAccessLevel(
  accessLevel: any,
  parameterName = 'accessLevel',
  required = true
): 'read' | 'write' {
  const levelStr = validateString(accessLevel, parameterName, { required });
  
  if (!levelStr && !required) {
    return 'read';
  }

  if (levelStr !== 'read' && levelStr !== 'write') {
    throw new ValidationError(
      `Parameter '${parameterName}' must be either 'read' or 'write'`,
      parameterName,
      accessLevel
    );
  }

  return levelStr;
}

// ==================== CONFIGURATION VALIDATORS ====================

/**
 * Validate PDW SDK configuration
 */
export function validatePDWConfig(config: any): void {
  if (!isObject(config)) {
    throw new ConfigurationError('Configuration must be an object');
  }

  // Validate package ID if provided
  if (config.packageId !== undefined) {
    validateObjectId(config.packageId, 'packageId');
  }

  // Validate API URL if provided
  if (config.apiUrl !== undefined) {
    validateString(config.apiUrl, 'apiUrl', {
      pattern: /^https?:\/\/.+/,
    });
  }

  // Validate encryption config if provided
  if (config.encryptionConfig !== undefined) {
    validateEncryptionConfig(config.encryptionConfig);
  }

  // Validate storage config if provided
  if (config.storageConfig !== undefined) {
    validateStorageConfig(config.storageConfig);
  }
}

/**
 * Validate encryption configuration
 */
export function validateEncryptionConfig(config: any): void {
  validateObject(config, 'encryptionConfig');

  if (config.enabled !== undefined) {
    validateBoolean(config.enabled, 'encryptionConfig.enabled');
  }

  if (config.keyServers !== undefined) {
    validateArray(config.keyServers, 'encryptionConfig.keyServers', {
      itemValidator: (server) => validateString(server, 'keyServer'),
    });
  }
}

/**
 * Validate storage configuration
 */
export function validateStorageConfig(config: any): void {
  validateObject(config, 'storageConfig');

  if (config.provider !== undefined) {
    const provider = validateString(config.provider, 'storageConfig.provider');
    if (provider !== 'walrus' && provider !== 'local') {
      throw new ValidationError(
        'storageConfig.provider must be either "walrus" or "local"',
        'storageConfig.provider',
        provider
      );
    }
  }

  if (config.cacheEnabled !== undefined) {
    validateBoolean(config.cacheEnabled, 'storageConfig.cacheEnabled');
  }

  if (config.encryptionEnabled !== undefined) {
    validateBoolean(config.encryptionEnabled, 'storageConfig.encryptionEnabled');
  }
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Sanitize user input to prevent common issues
 */
export function sanitizeString(input: string): string {
  return input
    .trim()
    .replace(/\0/g, '') // Remove null bytes
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Remove control characters
}

/**
 * Validate and normalize Sui address
 */
export function normalizeSuiAddress(address: string): string {
  const validated = validateSuiAddress(address, 'address');
  return validated.toLowerCase();
}

/**
 * Create validation wrapper for functions
 */
export function withValidation<T extends any[], R>(
  fn: (...args: T) => R,
  validators: Array<(arg: any, index: number) => any>
): (...args: T) => R {
  return (...args: T): R => {
    // Apply validators to arguments
    const validatedArgs = args.map((arg, index) => {
      if (validators[index]) {
        return validators[index](arg, index);
      }
      return arg;
    }) as T;

    return fn(...validatedArgs);
  };
}