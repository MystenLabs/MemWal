/**
 * Load PDW SDK SimplePDWClient
 * v0.3.4+ should have fixed the packaging issues
 */

export async function loadPDWClient() {
  try {
    console.log('🔄 Loading PDW SDK v0.3.4...');
    
    // Import from main entry point (should work now in v0.3.4)
    const pdwModule = await import('personal-data-wallet-sdk');
    const ClientClass = pdwModule.SimplePDWClient;
    
    if (!ClientClass) {
      throw new Error('SimplePDWClient not found in SDK export');
    }
    
    console.log('✅ PDW SDK loaded successfully!');
    return ClientClass;
  } catch (error: any) {
    console.error('❌ Failed to load PDW SDK:', error?.message);
    console.error('Full error:', error);
    
    throw new Error(`Failed to load personal-data-wallet-sdk v0.3.4
Error: ${error?.message || 'Unknown error'}

If this error persists, please report to SDK author.`);
  }
}
