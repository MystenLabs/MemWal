'use client';

import { useState, useMemo } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { ClientMemoryManager } from 'personal-data-wallet-sdk';

export function CreateMemory() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const [content, setContent] = useState('');
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Initialize ClientMemoryManager
  const memoryManager = useMemo(() => {
    return new ClientMemoryManager({
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID || '',
      accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID || '',
      walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR || '',
      geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY || '',
      enableLocalIndexing: true,
    });
  }, []);

  const handleCreate = async () => {
    console.log('\n🚀 ========== Starting Memory Creation ==========');

    if (!content.trim()) {
      setStatus('Please enter some content');
      return;
    }

    if (!account) {
      setStatus('Please connect your wallet');
      return;
    }

    setIsLoading(true);
    setStatus('Starting memory creation...');

    try {
      const blobId = await memoryManager.createMemory({
        content,
        account,
        signAndExecute: signAndExecute as any,
        client: client as any,
        onProgress: (status) => {
          console.log('📍', status);
          setStatus(status);
        }
      });

      console.log('🎉 ========== Memory Creation Complete! ==========');
      console.log('📦 Blob ID:', blobId);
      setStatus(`Memory created! Blob ID: ${blobId}`);

      // Clear form
      setContent('');
    } catch (error: any) {
      console.error('❌ ========== Error creating memory ==========');
      console.error(error);
      setStatus(`Error: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
      <h2 className="text-2xl font-bold text-white mb-4">Create Memory</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Memory Content
          </label>
          <textarea
            className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            rows={4}
            placeholder="Enter your memory content..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={isLoading}
          />
          <p className="text-xs text-slate-400 mt-1">
            💡 AI will analyze your content and extract metadata automatically
          </p>
        </div>

        <button
          onClick={handleCreate}
          disabled={isLoading || !content.trim()}
          className="w-full bg-primary hover:bg-primary/80 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-colors"
        >
          {isLoading ? 'Creating...' : 'Create Memory'}
        </button>

        {status && (
          <div className="mt-4 p-4 bg-white/5 border border-white/10 rounded-lg">
            <p className="text-sm text-slate-300 break-all">{status}</p>
          </div>
        )}
      </div>
    </div>
  );
}
