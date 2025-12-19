/**
 * Load PDW SDK SimplePDWClient
 */

export async function loadPDWClient() {
  try {
    const pdwModule = await import('@cmdoss/memwal-sdk');
    const ClientClass = pdwModule.SimplePDWClient;

    if (!ClientClass) {
      throw new Error('SimplePDWClient not found in SDK export');
    }

    console.log('✅ PDW SDK loaded successfully!');
    return ClientClass;
  } catch (error: any) {
    console.error('❌ Failed to load PDW SDK:', error?.message);
    throw error;
  }
}
