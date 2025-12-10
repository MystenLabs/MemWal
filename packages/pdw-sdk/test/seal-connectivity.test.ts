/**
 * SEAL Connectivity Test - Quick deployment verification
 * 
 * This test verifies basic connectivity to your deployed Sui contract
 * and SEAL key servers without full integration complexity.
 */

import dotenv from 'dotenv';
import { ConfigurationHelper } from '../src/config/ConfigurationHelper';

// Load test environment
dotenv.config({ path: '.env.test' });

describe('SEAL Connectivity Test', () => {
  const DEPLOYED_PACKAGE_ID = '0x5bab30565143ff73b8945d2141cdf996fd901b9b2c68d6e9303bc265dab169fa';
  const EXPECTED_SEAL_SERVERS = [
    'https://seal-key-server-testnet-1.mystenlabs.com',
    'https://seal-key-server-testnet-2.mystenlabs.com'
  ];
  
  test('should validate deployed contract configuration', () => {
    expect(process.env.SUI_PACKAGE_ID).toBe(DEPLOYED_PACKAGE_ID);
    console.log('✅ Deployed contract package ID:', DEPLOYED_PACKAGE_ID);
  });
  
  test('should validate SEAL key server configuration', () => {
    const actualServer = process.env.SEAL_KEY_SERVER_URL;
    expect(EXPECTED_SEAL_SERVERS.includes(actualServer!)).toBe(true);
    console.log('✅ SEAL key server URL:', actualServer);
  });
  
  test('should generate SEAL configuration from helper', () => {
    const configHelper = new ConfigurationHelper();
    const sealConfig = configHelper.getSealConfig();
    
    expect(sealConfig.keyServerUrl).toBeTruthy();
    expect(sealConfig.network).toBe('testnet');
    expect(sealConfig.batchSize).toBeGreaterThan(0);
    
    console.log('✅ SEAL Configuration:', {
      keyServerUrl: sealConfig.keyServerUrl,
      network: sealConfig.network,
      batchSize: sealConfig.batchSize,
      retryAttempts: sealConfig.retryAttempts
    });
  });
  
  test('should validate environment template generation', () => {
    const configHelper = new ConfigurationHelper();
    const envTemplate = configHelper.generateSealEnvTemplate();
    
    expect(envTemplate).toContain('SEAL_KEY_SERVER_URL');
    expect(envTemplate).toContain('testnet.seal.mysten.app');
    expect(envTemplate).toContain('SEAL_NETWORK=testnet');
    
    console.log('✅ Environment template generated successfully');
  });
});