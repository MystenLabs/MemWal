import { EmbeddingService } from '../src/services/EmbeddingService';

/**
 * Simple Google AI Embedding Test
 * Tests real embedding generation with the integrated API key
 */
async function testGoogleEmbedding() {
  console.log('🔍 Testing Google AI Embedding Generation');
  console.log('==========================================\n');

  const googleApiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (!googleApiKey) throw new Error('GOOGLE_AI_API_KEY or GEMINI_API_KEY required');
  const testInputs = [
    "I am a software engineer",
    "The weather is beautiful today",
    "Machine learning is fascinating",
    "Blockchain technology enables decentralized applications"
  ];

  const embeddingService = new EmbeddingService({
    apiKey: googleApiKey,
    model: 'text-embedding-004'
  });

  console.log(`📋 Configuration:`);
  console.log(`  - API Key: ${googleApiKey.substring(0, 20)}...`);
  console.log(`  - Model: text-embedding-004`);
  console.log(`  - Test inputs: ${testInputs.length} phrases\n`);

  try {
    for (let i = 0; i < testInputs.length; i++) {
      const input = testInputs[i];
      console.log(`🧮 Test ${i + 1}: "${input}"`);
      
      const startTime = Date.now();
      const result = await embeddingService.embedText({ text: input, type: 'content' });
      const endTime = Date.now();
      
      console.log(`✅ Generated embedding:`);
      console.log(`   Dimensions: ${result.vector.length}`);
      console.log(`   Sample values: [${result.vector.slice(0, 5).map(v => v.toFixed(6)).join(', ')}...]`);
      console.log(`   Processing time: ${endTime - startTime}ms`);
      console.log(`   Model: ${result.model}\n`);
    }

    console.log('🎉 All embedding tests completed successfully!');
    console.log('✅ Google AI API integration working correctly');
    
  } catch (error) {
    console.error('❌ Embedding test failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  testGoogleEmbedding().catch(console.error);
}

export { testGoogleEmbedding };