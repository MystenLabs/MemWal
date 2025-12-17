/**
 * Wallet Module
 *
 * @deprecated This module is deprecated. Use CapabilityService and ContextNamespace instead.
 * - MainWalletService → CapabilityService (from services/CapabilityService)
 * - ContextWalletService → ContextNamespace (from client/namespaces/ContextNamespace)
 *
 * These services will be removed in the next major version.
 */

/** @deprecated Use CapabilityService instead */
export { MainWalletService } from './MainWalletService';
export type { MainWalletServiceConfig } from './MainWalletService';

/** @deprecated Use ContextNamespace instead */
export { ContextWalletService } from './ContextWalletService';
export type { ContextWalletServiceConfig } from './ContextWalletService';
