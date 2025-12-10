'use client';

import { useState, useEffect, useMemo } from 'react';
import { useCurrentAccount, useSignPersonalMessage, useSuiClient } from '@mysten/dapp-kit';
import { ClientMemoryManager, ViewService } from 'personal-data-wallet-sdk';

interface MemoryWithContent {
  blobId: string;
  category: string;
  importance: number;
  contentLength: number;
  timestamp: Date;
  owner: string;
  content?: string;
}

export function MemoryList() {
  const account = useCurrentAccount();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const client = useSuiClient();

  const [memoriesWithContent, setMemoriesWithContent] = useState<MemoryWithContent[]>([]);
  const [decryptionStatus, setDecryptionStatus] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);

  // Initialize ViewService for querying memories
  const viewService = useMemo(() => {
    if (!client) return null;
    return new ViewService(client as any, {
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID || '',
    });
  }, [client]);

  // Query memories using SDK's ViewService
  useEffect(() => {
    if (!account?.address || !viewService) {
      console.log('⏸️ Waiting for wallet connection...');
      return;
    }

    const queryMemories = async () => {
      setQueryLoading(true);
      setQueryError(null);

      const packageId = process.env.NEXT_PUBLIC_PACKAGE_ID;
      const structType = `${packageId}::memory::Memory`;

      console.log('🔍 Querying memories using SDK ViewService...');
      console.log('📍 Wallet:', account.address);
      console.log('📦 Package ID:', packageId);
      console.log('🏗️ Struct Type:', structType);

      try {
        const result = await viewService.getUserMemories(account.address, {
          limit: 50
        });

        console.log('✅ ViewService response:', result);
        console.log('📊 Found', result.data.length, 'memories');

        if (result.data.length === 0) {
          console.log('ℹ️ No Memory objects found.');
          console.log('💡 This is a fresh deployment - create your first memory!');
        }

        // Convert ViewService MemoryRecord to MemoryWithContent
        const parsedMemories: MemoryWithContent[] = result.data.map(memory => {
          console.log('📝 Memory:', memory);
          return {
            blobId: memory.blobId,
            category: memory.category,
            importance: memory.importance,
            contentLength: memory.contentSize,
            timestamp: new Date(memory.createdAt),
            owner: account.address,
          };
        });

        console.log('✅ Parsed', parsedMemories.length, 'memories');
        setMemoriesWithContent(parsedMemories);
        setQueryLoading(false);

      } catch (err: any) {
        console.error('❌ Query failed:', err);
        setQueryError(err.message);
        setQueryLoading(false);
      }
    };

    queryMemories();
  }, [account?.address, viewService]);

  // Handle refresh button click
  const handleRefresh = async () => {
    if (!account?.address || !viewService) return;

    setIsRefreshing(true);
    setDecryptionStatus('Refreshing memories...');
    setMemoriesWithContent([]);

    console.log('🔄 Refreshing memories using ViewService...');

    try {
      const result = await viewService.getUserMemories(account.address, {
        limit: 50
      });

      const parsedMemories: MemoryWithContent[] = result.data.map(memory => ({
        blobId: memory.blobId,
        category: memory.category,
        importance: memory.importance,
        contentLength: memory.contentSize,
        timestamp: new Date(memory.createdAt),
        owner: account.address,
      }));

      console.log('✅ Refreshed:', parsedMemories.length, 'memories');
      setMemoriesWithContent(parsedMemories);
      setDecryptionStatus('');
    } catch (error: any) {
      console.error('❌ Refresh failed:', error);
      setQueryError(error.message);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Initialize ClientMemoryManager for decryption
  const memoryManager = useMemo(() => {
    return new ClientMemoryManager({
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID || '',
      accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID || '',
      walrusAggregator: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR || '',
      geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY || '',
    });
  }, []);

  // Batch decrypt memories when they're loaded
  useEffect(() => {
    if (memoriesWithContent.length > 0 && account && signPersonalMessage && client && !isRefreshing) {
      // Check if any memories need decryption
      const needsDecryption = memoriesWithContent.some(m => !m.content);

      if (!needsDecryption) {
        console.log('✅ All memories already decrypted');
        return;
      }

      const decryptMemories = async () => {
        console.log('📊 Found', memoriesWithContent.length, 'memories on-chain');
        console.log('🔓 Starting batch decryption with SINGLE signature...');
        setDecryptionStatus('Initializing decryption (sign once)...');

        try {
          const blobIds = memoriesWithContent.map(m => m.blobId);

          // Batch decrypt with SINGLE signature
          const results = await memoryManager.batchRetrieveMemories({
            blobIds,
            account,
            signPersonalMessage: signPersonalMessage as any,
            client: client as any,
            onProgress: (status, current, total) => {
              console.log(`📍 ${status} (${current}/${total})`);
              setDecryptionStatus(`${status} (${current}/${total})`);
            }
          });

          console.log('✅ Decryption complete:', results.length, 'results');

          // Update memories with decrypted content
          setMemoriesWithContent(prev =>
            prev.map(memory => {
              const result = results.find(r => r.blobId === memory.blobId);
              if (result) {
                return {
                  ...memory,
                  content: result.content || result.error || 'Decryption failed'
                };
              }
              return memory;
            })
          );

          setDecryptionStatus('All memories decrypted!');
          setTimeout(() => setDecryptionStatus(''), 2000);
        } catch (error: any) {
          console.error('❌ Batch decryption failed:', error);
          setDecryptionStatus(`Error: ${error.message}`);
        }
      };

      decryptMemories();
    }
  }, [memoriesWithContent.length, account, signPersonalMessage, client, memoryManager, isRefreshing]);

  return (
    <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-white">Your Memories</h2>
        <button
          onClick={handleRefresh}
          disabled={queryLoading || isRefreshing}
          className="bg-primary/20 hover:bg-primary/30 disabled:bg-slate-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm transition-colors"
        >
          {queryLoading || isRefreshing ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Debug Info Panel */}
      <div className="mb-4 p-4 bg-slate-800/50 border border-slate-600/50 rounded-lg text-xs font-mono">
        <div className="text-slate-300 mb-2 font-bold">🔍 Debug Information:</div>
        <div className="space-y-1 text-slate-400">
          <div>📍 Wallet: {account?.address ? `${account.address.slice(0, 10)}...${account.address.slice(-8)}` : '❌ Not connected'}</div>
          <div>📦 Package ID: {process.env.NEXT_PUBLIC_PACKAGE_ID?.slice(0, 10)}...{process.env.NEXT_PUBLIC_PACKAGE_ID?.slice(-8)}</div>
          <div>🏗️ Struct Type: {process.env.NEXT_PUBLIC_PACKAGE_ID}::memory::Memory</div>
          <div>📊 Memories Found: {memoriesWithContent.length}</div>
          <div>⏱️ Status: {queryLoading ? '⏳ Loading...' : isRefreshing ? '🔄 Refreshing...' : '✅ Ready'}</div>
        </div>
        {!account && (
          <div className="mt-2 p-2 bg-yellow-500/20 border border-yellow-500/50 rounded text-yellow-300 text-xs">
            ⚠️ Please connect your wallet to query memories
          </div>
        )}
        {account && memoriesWithContent.length === 0 && !queryLoading && (
          <div className="mt-2 p-2 bg-blue-500/20 border border-blue-500/50 rounded text-blue-300 text-xs">
            💡 No memories found. This is a fresh deployment - create your first memory using the "Create Memory" tab!
          </div>
        )}
      </div>

      {queryError && (
        <div className="mb-4 p-4 bg-red-500/20 border border-red-500/50 rounded-lg">
          <p className="text-sm text-red-300">{queryError}</p>
        </div>
      )}

      {decryptionStatus && (
        <div className="mb-4 p-3 bg-blue-500/20 border border-blue-500/50 rounded-lg">
          <p className="text-sm text-blue-300">{decryptionStatus}</p>
        </div>
      )}

      <div className="space-y-4">
        {queryLoading ? (
          <div className="text-center py-8">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
            <p className="text-slate-300 mt-2">Loading memories...</p>
          </div>
        ) : memoriesWithContent.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-slate-300">No memories yet. Create your first one!</p>
          </div>
        ) : (
          memoriesWithContent.map((memory) => (
            <div
              key={memory.blobId}
              className="bg-white/5 border border-white/10 rounded-lg p-4 hover:bg-white/10 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="font-semibold text-white mb-1">
                    {memory.category}
                  </h3>
                  <div className="flex items-center gap-4 text-xs text-slate-400">
                    <span>
                      {memory.timestamp.toLocaleDateString()}
                    </span>
                    <span>
                      Importance: {memory.importance}/10
                    </span>
                    <span>
                      {memory.contentLength} bytes
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {memory.content ? (
                  <div className="text-sm text-slate-200 bg-white/5 rounded p-3 border border-white/10">
                    {memory.content}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 italic">
                    Decrypting...
                  </div>
                )}
                <div className="text-xs text-slate-500 font-mono break-all">
                  Blob: {memory.blobId.substring(0, 32)}...
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {memoriesWithContent.length > 0 && (
        <div className="mt-4 text-sm text-slate-400 text-center">
          {memoriesWithContent.length} {memoriesWithContent.length === 1 ? 'memory' : 'memories'} found
        </div>
      )}
    </div>
  );
}
