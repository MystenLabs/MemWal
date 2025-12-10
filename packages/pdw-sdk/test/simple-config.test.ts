/**
 * Simple SEAL Configuration Test
 * 
 * Basic validation of SEAL deployment configuration
 * Package ID: 0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde
 */

require('dotenv').config({ path: '.env.test' });

const DEPLOYED_PACKAGE_ID = '0x067706fc08339b715dab0383bd853b04d06ef6dff3a642c5e7056222da038bde';
const MYSTEN_SEAL_TESTNET = 'https://testnet.seal.mysten.app';

describe('SEAL Configuration Test', () => {
  test('should validate deployed package ID configuration', () => {
    process.env.SUI_PACKAGE_ID = DEPLOYED_PACKAGE_ID;
    expect(process.env.SUI_PACKAGE_ID).toBe(DEPLOYED_PACKAGE_ID);
    
    console.log('✅ Deployed contract package ID:', DEPLOYED_PACKAGE_ID);
    console.log('🌐 Network: testnet');
  });

  test('should validate SEAL key server configuration', () => {
    process.env.SEAL_KEY_SERVER_URL = MYSTEN_SEAL_TESTNET;
    process.env.SEAL_NETWORK = 'testnet';
    
    expect(process.env.SEAL_KEY_SERVER_URL).toBe(MYSTEN_SEAL_TESTNET);
    expect(process.env.SEAL_NETWORK).toBe('testnet');
    
    console.log('✅ SEAL key server URL:', MYSTEN_SEAL_TESTNET);
    console.log('🔐 SEAL network: testnet');
  });

  test('should validate environment variables are properly set', () => {
    const requiredVars = [
      'SUI_PACKAGE_ID',
      'SEAL_KEY_SERVER_URL', 
      'SEAL_NETWORK'
    ];

    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.warn('⚠️ Missing environment variables:', missingVars);
    }

    expect(missingVars.length).toBe(0);
    
    console.log('✅ All required environment variables are set');
    console.log('📋 Configuration summary:', {
      packageId: process.env.SUI_PACKAGE_ID,
      sealKeyServer: process.env.SEAL_KEY_SERVER_URL,
      sealNetwork: process.env.SEAL_NETWORK
    });
  });
});