/**
 * Configuration Module
 *
 * Comprehensive configuration management for the PDW SDK,
 * including environment variable support and validation.
 */

export { ConfigurationHelper, Config } from './ConfigurationHelper';
export type { SDKConfig, EnvironmentConfig } from './ConfigurationHelper';

// Model defaults - centralized AI model configuration
export {
  MODEL_DEFAULTS,
  getDefaultEmbeddingModel,
  getChatModel
} from './modelDefaults';