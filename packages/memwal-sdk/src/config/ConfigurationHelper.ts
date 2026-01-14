/**
 * Configuration Utilities for Personal Data Wallet SDK
 * 
 * Provides helpers for managing API keys, environment variables,
 * and configuration validation across the SDK.
 */

export interface SDKConfig {
  // AI/Embedding configuration
  geminiApiKey?: string;
  embeddingModel?: string;
  
  // Blockchain configuration
  suiNetwork?: 'testnet' | 'mainnet' | 'devnet' | 'localnet';
  suiPackageId?: string;
  suiAdminPrivateKey?: string;
  
  // Storage configuration
  walrusNetwork?: 'testnet' | 'mainnet';
  walrusUploadRelay?: string;
  
  // SEAL encryption configuration
  sealKeyServerUrl?: string;
  sealKeyServerObjectId?: string;
  sealSessionTTL?: number;
  sealEnableBatch?: boolean;
  sealBatchSize?: number;
  sealDecryptionTimeout?: number;
  sealVerifyServers?: boolean;
  sealEnableAudit?: boolean;
  
  // Feature flags
  enableEncryption?: boolean;
  enableBatching?: boolean;
  enableMonitoring?: boolean;
}

export interface EnvironmentConfig {
  // Gemini AI
  GEMINI_API_KEY?: string;
  GOOGLE_AI_API_KEY?: string;
  
  // Sui Blockchain
  SUI_NETWORK?: string;
  SUI_PACKAGE_ID?: string;
  SUI_ADMIN_PRIVATE_KEY?: string;
  
  // Walrus Storage
  WALRUS_NETWORK?: string;
  WALRUS_UPLOAD_RELAY?: string;
  
  // SEAL Encryption
  SEAL_KEY_SERVER_URL?: string;
  SEAL_KEY_SERVER_OBJECT_ID?: string;
  SEAL_SESSION_TTL?: string;
  SEAL_ENABLE_BATCH?: string;
  SEAL_BATCH_SIZE?: string;
  SEAL_DECRYPTION_TIMEOUT?: string;
  SEAL_VERIFY_SERVERS?: string;
  SEAL_ENABLE_AUDIT?: string;
  
  // Feature toggles
  PDW_ENABLE_ENCRYPTION?: string;
  PDW_ENABLE_BATCHING?: string;
  PDW_ENABLE_MONITORING?: string;
}

/**
 * Configuration helper with environment variable support
 */
export class ConfigurationHelper {
  constructor() {
    // Instance constructor for backwards compatibility
  }
  /**
   * Get Gemini API key from various sources
   */
  static getGeminiApiKey(providedKey?: string): string {
    const apiKey = providedKey || 
                   process.env.GEMINI_API_KEY || 
                   process.env.GOOGLE_AI_API_KEY;
    
    if (!apiKey) {
      throw new Error(
        '🔑 Gemini API key is required. Set it via:\n\n' +
        '1. Direct configuration:\n' +
        '   const pipeline = createQuickStartPipeline("BASIC", {\n' +
        '     embedding: { apiKey: "your-api-key" }\n' +
        '   });\n\n' +
        '2. Environment variable:\n' +
        '   export GEMINI_API_KEY="your-api-key"\n' +
        '   # or\n' +
        '   export GOOGLE_AI_API_KEY="your-api-key"\n\n' +
        '3. .env file:\n' +
        '   GEMINI_API_KEY=your-api-key\n\n' +
        '📝 Get your free API key from: https://makersuite.google.com/app/apikey'
      );
    }
    
    return apiKey;
  }

  /**
   * Get Sui configuration from environment
   */
  static getSuiConfig(): {
    network: 'testnet' | 'mainnet' | 'devnet' | 'localnet';
    packageId?: string;
    adminPrivateKey?: string;
  } {
    const network = (process.env.SUI_NETWORK as any) || 'testnet';
    
    return {
      network,
      packageId: process.env.SUI_PACKAGE_ID,
      adminPrivateKey: process.env.SUI_ADMIN_PRIVATE_KEY
    };
  }

  /**
   * Get Walrus configuration from environment
   */
  static getWalrusConfig(): {
    network: 'testnet' | 'mainnet';
    uploadRelay?: string;
  } {
    const network = (process.env.WALRUS_NETWORK as any) || 'testnet';
    
    return {
      network,
      uploadRelay: process.env.WALRUS_UPLOAD_RELAY
    };
  }

  /**
   * Get SEAL key server configuration from environment
   */
  static getSealConfig(): {
    keyServerUrl?: string;
    keyServerObjectId?: string;
    sessionTTL: number;
    enableBatch: boolean;
    batchSize: number;
    decryptionTimeout: number;
    verifyServers: boolean;
    enableAudit: boolean;
    network: string;
    retryAttempts: number;
  } {
    return {
      keyServerUrl: process.env.SEAL_KEY_SERVER_URL || 'https://testnet.seal.mysten.app',
      keyServerObjectId: process.env.SEAL_KEY_SERVER_OBJECT_ID,
      sessionTTL: process.env.SEAL_SESSION_TTL ? parseInt(process.env.SEAL_SESSION_TTL) : 60,
      enableBatch: process.env.SEAL_ENABLE_BATCH === 'true',
      batchSize: process.env.SEAL_BATCH_SIZE ? parseInt(process.env.SEAL_BATCH_SIZE) : 10,
      decryptionTimeout: process.env.SEAL_DECRYPTION_TIMEOUT ? parseInt(process.env.SEAL_DECRYPTION_TIMEOUT) : 30000,
      verifyServers: process.env.SEAL_VERIFY_SERVERS !== 'false', // Default true
      enableAudit: process.env.SEAL_ENABLE_AUDIT === 'true',
      network: process.env.SEAL_NETWORK || 'testnet',
      retryAttempts: process.env.SEAL_RETRY_ATTEMPTS ? parseInt(process.env.SEAL_RETRY_ATTEMPTS) : 3
    };
  }

  /**
   * Instance method for getSealConfig (for backwards compatibility)
   */
  getSealConfig(): {
    keyServerUrl?: string;
    keyServerObjectId?: string;
    sessionTTL: number;
    enableBatch: boolean;
    batchSize: number;
    decryptionTimeout: number;
    verifyServers: boolean;
    enableAudit: boolean;
    network: string;
    retryAttempts: number;
  } {
    return ConfigurationHelper.getSealConfig();
  }

  /**
   * Load configuration from environment variables
   */
  static loadFromEnvironment(): SDKConfig {
    return {
      // AI Configuration
      geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY,
      embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-004',
      
      // Blockchain Configuration
      suiNetwork: (process.env.SUI_NETWORK as any) || 'testnet',
      suiPackageId: process.env.SUI_PACKAGE_ID,
      suiAdminPrivateKey: process.env.SUI_ADMIN_PRIVATE_KEY,
      
      // Storage Configuration
      walrusNetwork: (process.env.WALRUS_NETWORK as any) || 'testnet',
      walrusUploadRelay: process.env.WALRUS_UPLOAD_RELAY,
      
      // Feature Flags
      enableEncryption: this.parseBooleanEnv('PDW_ENABLE_ENCRYPTION', true),
      enableBatching: this.parseBooleanEnv('PDW_ENABLE_BATCHING', true),
      enableMonitoring: this.parseBooleanEnv('PDW_ENABLE_MONITORING', true)
    };
  }

  /**
   * Validate that required configuration is present
   */
  static validateConfig(config: Partial<SDKConfig>): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for Gemini API key
    try {
      this.getGeminiApiKey(config.geminiApiKey);
    } catch (error) {
      errors.push('Missing Gemini API key for AI embedding generation');
    }

    // Validate Sui configuration
    if (config.suiPackageId && !config.suiPackageId.startsWith('0x')) {
      errors.push('Invalid Sui package ID format (should start with 0x)');
    }

    if (config.suiAdminPrivateKey && config.suiAdminPrivateKey.length < 32) {
      warnings.push('Sui admin private key seems too short');
    }

    // Network consistency check
    if (config.suiNetwork !== config.walrusNetwork) {
      warnings.push('Sui and Walrus networks should typically match');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Create a complete configuration with smart defaults
   */
  static createConfig(overrides: Partial<SDKConfig> = {}): SDKConfig {
    const envConfig = this.loadFromEnvironment();
    const merged = { ...envConfig, ...overrides };
    
    // Validate the final configuration
    const validation = this.validateConfig(merged);
    
    if (!validation.isValid) {
      throw new Error(
        `Configuration validation failed:\n${validation.errors.join('\n')}`
      );
    }

    if (validation.warnings.length > 0) {
      console.warn('⚠️ Configuration warnings:', validation.warnings);
    }

    return merged;
  }

  /**
   * Print current configuration (masking sensitive data)
   */
  static printConfig(config: SDKConfig): void {
    const masked = {
      ...config,
      geminiApiKey: config.geminiApiKey ? this.maskApiKey(config.geminiApiKey) : undefined,
      suiAdminPrivateKey: config.suiAdminPrivateKey ? this.maskPrivateKey(config.suiAdminPrivateKey) : undefined
    };

    console.log('📋 PDW SDK Configuration:');
    console.table(masked);
  }

  /**
   * Generate example .env file content
   */
  static generateEnvTemplate(): string {
    return `# Personal Data Wallet SDK Configuration
# Copy this to your .env file and fill in your values

# 🧠 AI/Embedding Configuration (Required)
GEMINI_API_KEY=your_gemini_api_key_here
# Get your key from: https://makersuite.google.com/app/apikey

# ⛓️ Sui Blockchain Configuration (Optional)
SUI_NETWORK=testnet
SUI_PACKAGE_ID=your_deployed_package_id_here
SUI_ADMIN_PRIVATE_KEY=your_sui_private_key_here

# 🗄️ Walrus Storage Configuration (Optional)
WALRUS_NETWORK=testnet
WALRUS_UPLOAD_RELAY=https://upload-relay.testnet.walrus.space

# 🔐 SEAL Encryption Configuration (Optional)
# Uses official Mysten Labs testnet servers by default
# Configure custom key server if needed:
SEAL_KEY_SERVER_URL=your_custom_key_server_url
SEAL_KEY_SERVER_OBJECT_ID=your_custom_key_server_object_id
SEAL_SESSION_TTL=60
SEAL_ENABLE_BATCH=true
SEAL_BATCH_SIZE=10
SEAL_DECRYPTION_TIMEOUT=30000
SEAL_VERIFY_SERVERS=true
SEAL_ENABLE_AUDIT=false

# 🎛️ Feature Flags (Optional)
PDW_ENABLE_ENCRYPTION=true
PDW_ENABLE_BATCHING=true
PDW_ENABLE_MONITORING=true

# 🔧 Advanced Settings (Optional)
EMBEDDING_MODEL=text-embedding-004
`;
  }

  /**
   * Generate SEAL-specific environment template
   */
  static generateSealEnvTemplate(): string {
    return `# SEAL Encryption Configuration for Personal Data Wallet SDK

# 🔑 SEAL Key Server Configuration
SEAL_KEY_SERVER_URL=https://testnet.seal.mysten.app
SEAL_NETWORK=testnet

# 🔧 SEAL Performance Settings
SEAL_BATCH_SIZE=10
SEAL_RETRY_ATTEMPTS=3
SEAL_DECRYPTION_TIMEOUT=30000
SEAL_SESSION_TTL=60

# 🛡️ SEAL Security Settings
SEAL_VERIFY_SERVERS=true
SEAL_ENABLE_AUDIT=false
SEAL_ENABLE_BATCH=true

# 📦 Deployed Contract Configuration
SUI_PACKAGE_ID=0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde
SUI_NETWORK=testnet

# 🔑 Testnet Key Servers (Official Mysten Labs)
SEAL_KEY_SERVER_1_URL=https://seal-key-server-testnet-1.mystenlabs.com
SEAL_KEY_SERVER_1_OBJECT=0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75
SEAL_KEY_SERVER_2_URL=https://seal-key-server-testnet-2.mystenlabs.com
SEAL_KEY_SERVER_2_OBJECT=0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8
`;
  }

  /**
   * Instance method for generateSealEnvTemplate (for backwards compatibility)
   */
  generateSealEnvTemplate(): string {
    return ConfigurationHelper.generateSealEnvTemplate();
  }

  // Private helper methods
  private static parseBooleanEnv(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (value === undefined) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
  }

  private static maskApiKey(apiKey: string): string {
    if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
    return apiKey.substring(0, 4) + '*'.repeat(apiKey.length - 8) + apiKey.substring(apiKey.length - 4);
  }

  private static maskPrivateKey(privateKey: string): string {
    if (privateKey.length <= 16) return '*'.repeat(privateKey.length);
    return privateKey.substring(0, 6) + '*'.repeat(privateKey.length - 12) + privateKey.substring(privateKey.length - 6);
  }
}

/**
 * Quick configuration helpers
 */
export const Config = {
  /**
   * Create configuration from environment variables
   */
  fromEnv: (): SDKConfig => ConfigurationHelper.loadFromEnvironment(),
  
  /**
   * Create configuration with validation
   */
  create: (overrides?: Partial<SDKConfig>): SDKConfig => ConfigurationHelper.createConfig(overrides),
  
  /**
   * Validate existing configuration
   */
  validate: (config: Partial<SDKConfig>) => ConfigurationHelper.validateConfig(config),
  
  /**
   * Get Gemini API key with helpful error messages
   */
  getGeminiKey: (key?: string): string => ConfigurationHelper.getGeminiApiKey(key),
  
  /**
   * Generate .env template
   */
  generateEnvTemplate: (): string => ConfigurationHelper.generateEnvTemplate()
};

export default ConfigurationHelper;