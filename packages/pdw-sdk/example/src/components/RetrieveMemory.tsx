'use client';

import { useState, useMemo } from 'react';
import { useCurrentAccount, useSuiClient, useSignPersonalMessage } from '@mysten/dapp-kit';
import { ClientMemoryManager } from 'personal-data-wallet-sdk';

export function RetrieveMemory() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const [blobId, setBlobId] = useState('');
  const [decryptedContent, setDecryptedContent] = useState('');
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Initialize ClientMemoryManager
  const memoryManager = useMemo(() => {
    return new ClientMemoryManager({
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID || '',
      accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID || '',
      walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR || '',
      geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY || '',
    });
  }, []);

  const handleRetrieve = async () => {
    console.log('\n🔍 ========== Starting Memory Retrieval ==========');

    if (!blobId.trim()) {
      setStatus('Please enter a blob ID');
      return;
    }

    if (!account) {
      setStatus('Please connect your wallet');
      return;
    }

    console.log('📥 Blob ID to retrieve:', blobId);

    setIsLoading(true);
    setStatus('Starting retrieval...');
    setDecryptedContent('');

    try {
      const memoryData = await memoryManager.retrieveMemory({
        blobId,
        account,
        signPersonalMessage: signPersonalMessage as any,
        client: client as any,
        onProgress: (status) => {
          console.log('📍', status);
          setStatus(status);
        }
      });

      console.log('🎉 ========== Retrieval Complete ==========');
      setDecryptedContent(JSON.stringify(memoryData, null, 2));
      setStatus('Successfully decrypted!');
    } catch (error: any) {
      console.error('❌ ========== Error retrieving memory ==========');
      console.error(error);
      setStatus(`Error: ${error.message}`);
      setDecryptedContent('');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
      <h2 className="text-2xl font-bold text-white mb-4">Retrieve & Decrypt Memory</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Walrus Blob ID
          </label>
          <input
            type="text"
            className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-secondary focus:border-transparent"
            placeholder="Enter blob ID from Walrus..."
            value={blobId}
            onChange={(e) => setBlobId(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <button
          onClick={handleRetrieve}
          disabled={isLoading || !blobId.trim()}
          className="w-full bg-secondary hover:bg-secondary/80 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-colors"
        >
          {isLoading ? 'Retrieving...' : 'Retrieve & Decrypt'}
        </button>

        {status && (
          <div className="p-4 bg-white/5 border border-white/10 rounded-lg">
            <p className="text-sm text-slate-300 break-all">{status}</p>
          </div>
        )}

        {decryptedContent && (
          <div className="p-4 bg-white/5 border border-white/10 rounded-lg">
            <h3 className="text-sm font-semibold text-white mb-2">Decrypted Content:</h3>
            <pre className="text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap">
              {decryptedContent}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
