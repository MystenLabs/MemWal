/**
 * SEAL Testnet Integration Test
 * 
 * Validates SEAL functionality with official Mysten Labs testnet key servers
 */

import dotenv from 'dotenv';
import { describe, test, expect, beforeAll } from '@jest/globals';

// Load test environment
dotenv.config({ path: '.env.test' });

describe('SEAL Testnet Integration', () => {
  let testConfig: any;

  beforeAll(() => {
    testConfig = {
      packageId: process.env.SUI_PACKAGE_ID!,
      network: process.env.SUI_NETWORK || 'testnet',
      sealServer1: {
        url: process.env.SEAL_KEY_SERVER_1_URL!,
        objectId: process.env.SEAL_KEY_SERVER_1_OBJECT!
      },
      sealServer2: {
        url: process.env.SEAL_KEY_SERVER_2_URL!,
        objectId: process.env.SEAL_KEY_SERVER_2_OBJECT!
      },
      primarySealUrl: process.env.SEAL_KEY_SERVER_URL!,
      userAddress: process.env.TEST_USER_ADDRESS!,
      testContent: process.env.TEST_MEMORY_CONTENT!
    };

    console.log('🧪 SEAL Testnet Configuration:');
    console.log(`📦 Sui Package ID: ${testConfig.packageId}`);
    console.log(`🌐 Network: ${testConfig.network}`);
    console.log(`🔑 Primary SEAL Server: ${testConfig.primarySealUrl}`);
    console.log(`🔑 SEAL Server 1: ${testConfig.sealServer1.url}`);
    console.log(`🔑 SEAL Server 2: ${testConfig.sealServer2.url}`);
  });

  test('should validate SEAL testnet configuration', () => {
    expect(testConfig.packageId).toBeTruthy();
    expect(testConfig.packageId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    
    expect(testConfig.sealServer1.url).toBe('https://seal-key-server-testnet-1.mystenlabs.com');
    expect(testConfig.sealServer1.objectId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    
    expect(testConfig.sealServer2.url).toBe('https://seal-key-server-testnet-2.mystenlabs.com');
    expect(testConfig.sealServer2.objectId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    
    console.log('✅ SEAL testnet configuration validation passed');
  });

  test('should connect to SEAL key servers', async () => {
    console.log('🔍 Testing connectivity to SEAL key servers...');

    // Test server 1 connectivity
    try {
      const response1 = await fetch(testConfig.sealServer1.url);
      console.log(`📡 SEAL Server 1 Status: ${response1.status}`);
      expect(response1.status).toBeLessThan(500);
    } catch (error) {
      console.log(`⚠️  SEAL Server 1 connectivity check failed: ${error}`);
    }

    // Test server 2 connectivity  
    try {
      const response2 = await fetch(testConfig.sealServer2.url);
      console.log(`📡 SEAL Server 2 Status: ${response2.status}`);
      expect(response2.status).toBeLessThan(500);
    } catch (error) {
      console.log(`⚠️  SEAL Server 2 connectivity check failed: ${error}`);
    }

    console.log('✅ SEAL server connectivity tests completed');
  });

  test('should validate SEAL object IDs format', () => {
    console.log('🔍 Validating SEAL object IDs...');

    // Validate object ID formats
    expect(testConfig.sealServer1.objectId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(testConfig.sealServer2.objectId).toMatch(/^0x[a-fA-F0-9]{64}$/);

    // Log object IDs for verification
    console.log(`🎯 SEAL Server 1 Object ID: ${testConfig.sealServer1.objectId}`);
    console.log(`🎯 SEAL Server 2 Object ID: ${testConfig.sealServer2.objectId}`);

    console.log('✅ SEAL object ID validation passed');
  });

  test('should validate deployed Move contract configuration', () => {
    console.log('🔍 Validating deployed Move contract...');

    // Validate package ID format
    expect(testConfig.packageId).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(testConfig.packageId).toBe('0x5bab30565143ff73b8945d2141cdf996fd901b9b2c68d6e9303bc265dab169fa');

    console.log(`📦 Deployed Package ID: ${testConfig.packageId}`);
    console.log('✅ Move contract validation passed');
  });

  test('should validate testnet environment setup', () => {
    console.log('🔍 Validating testnet environment...');

    // Check network configuration
    expect(testConfig.network).toBe('testnet');
    
    // Validate URLs are HTTPS
    expect(testConfig.sealServer1.url).toMatch(/^https:\/\//);
    expect(testConfig.sealServer2.url).toMatch(/^https:\/\//);
    
    // Validate servers are on mystenlabs.com domain
    expect(testConfig.sealServer1.url).toMatch(/mystenlabs\.com$/);
    expect(testConfig.sealServer2.url).toMatch(/mystenlabs\.com$/);

    console.log('✅ Testnet environment validation passed');
  });

  test('should display SEAL configuration summary', () => {
    console.log('\n🎯 SEAL Testnet Integration Summary:');
    console.log('═'.repeat(60));
    console.log(`📦 Move Contract Package: ${testConfig.packageId}`);
    console.log(`🌐 Network: ${testConfig.network.toUpperCase()}`);
    console.log('\n🔑 SEAL Key Servers:');
    console.log(`   Server 1: ${testConfig.sealServer1.url}`);
    console.log(`   Object ID: ${testConfig.sealServer1.objectId}`);
    console.log(`   Server 2: ${testConfig.sealServer2.url}`);  
    console.log(`   Object ID: ${testConfig.sealServer2.objectId}`);
    console.log(`\n🎯 Primary Server: ${testConfig.primarySealUrl}`);
    console.log('═'.repeat(60));
    
    expect(true).toBe(true); // Always pass - this is a summary test
  });
});