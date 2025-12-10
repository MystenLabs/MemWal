/**
 * Encryption Module - DEPRECATED
 * 
 * ⚠️ DEPRECATION NOTICE:
 * This directory is deprecated. Use services/EncryptionService instead.
 * 
 * Migration Guide:
 * - EncryptionService → services/EncryptionService
 * 
 * This export is maintained for backward compatibility only.
 */

// Re-export from production location
export { EncryptionService } from '../services/EncryptionService';
export type {
  AccessGrantOptions,
  AccessRevokeOptions
} from '../services/EncryptionService';

