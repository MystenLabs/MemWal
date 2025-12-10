'use client';

import React, { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useSearchMemories } from 'personal-data-wallet-sdk/hooks';
import { IndexedDBInspector } from './IndexedDBInspector';

type Tab = 'search' | 'indexdb';

export function SearchMemory() {
  const account = useCurrentAccount();
  const [activeTab, setActiveTab] = useState<Tab>('search');
  const [query, setQuery] = useState('');
  const [minSimilarity, setMinSimilarity] = useState(0.5);
  const [resultCount, setResultCount] = useState(5);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  // Debug: Check if API key is available
  const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  console.log('🔑 SearchMemory - API Key available:', !!apiKey, apiKey ? `(${apiKey.substring(0, 10)}...)` : 'UNDEFINED');
  console.log('🔍 SearchMemory - User address:', account?.address);
  console.log('🔍 SearchMemory - Query:', query);

  const addDebugLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDebugLogs(prev => [...prev, `[${timestamp}] ${message}`]);
    console.log(`🐛 [SearchMemory] ${message}`);
  };

  // Check IndexedDB status when component mounts
  React.useEffect(() => {
    if (account?.address) {
      addDebugLog(`Component mounted for user: ${account.address.slice(0, 10)}...`);
      checkIndexedDBStatus();
    }
  }, [account?.address]);

  const checkIndexedDBStatus = async () => {
    try {
      addDebugLog('Checking IndexedDB for existing index...');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('HnswIndexDB', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      if (!db.objectStoreNames.contains('indices')) {
        addDebugLog('❌ No indices object store found in IndexedDB');
        db.close();
        return;
      }

      const tx = db.transaction(['indices'], 'readonly');
      const store = tx.objectStore('indices');
      const getRequest = store.get(account?.address);

      const indexData = await new Promise<any>((resolve) => {
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => resolve(null);
      });

      if (!indexData) {
        addDebugLog('❌ No index found for this user in IndexedDB');
      } else {
        addDebugLog(`✅ Index found! Version: ${indexData.version}`);
        addDebugLog(`   Vectors in metadata: ${Object.keys(indexData.metadata || {}).length}`);
        addDebugLog(`   Last updated: ${new Date(indexData.lastUpdated).toLocaleString()}`);
      }

      db.close();
    } catch (error: any) {
      addDebugLog(`❌ IndexedDB check failed: ${error.message}`);
    }
  };

const { data: results, isLoading, error } = useSearchMemories(
    account?.address,
    query,
    {
      k: resultCount,
      minSimilarity,
      enabled: query.length > 2, // Only search when query has 3+ chars
      debounceMs: 500,
      geminiApiKey: apiKey,
    }
  );

  // Debug: Log search results
  React.useEffect(() => {
    if (query.length >= 3) {
      if (isLoading) {
        addDebugLog(`⏳ Searching for: "${query}"`);
      } else if (error) {
        addDebugLog(`❌ Search error: ${error.message}`);
      } else if (results) {
        addDebugLog(`✅ Search completed: ${results.length} results`);
        if (results.length > 0) {
          results.forEach((r, i) => {
            addDebugLog(`   ${i + 1}. Similarity: ${(r.similarity * 100).toFixed(1)}% - ${r.category}`);
          });
        }
      }
    }
  }, [results, isLoading, error, query]);

  // Show connection prompt if wallet not connected
  if (!account?.address) {
    return (
      <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
        <h2 className="text-2xl font-bold text-white mb-4">Vector Search & IndexedDB</h2>
        <div className="text-center py-8">
          <p className="text-slate-300 mb-4">
            Please connect your wallet to search memories and inspect IndexedDB
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
      {/* Tab Navigation */}
      <div className="flex gap-2 mb-6 border-b border-white/10">
        <button
          onClick={() => setActiveTab('search')}
          className={`px-4 py-2 font-medium transition-colors relative ${
            activeTab === 'search'
              ? 'text-white'
              : 'text-slate-400 hover:text-slate-300'
          }`}
        >
          🔍 Vector Search
          {activeTab === 'search' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"></div>
          )}
        </button>
        <button
          onClick={() => setActiveTab('indexdb')}
          className={`px-4 py-2 font-medium transition-colors relative ${
            activeTab === 'indexdb'
              ? 'text-white'
              : 'text-slate-400 hover:text-slate-300'
          }`}
        >
          💾 IndexedDB Inspector
          {activeTab === 'indexdb' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary"></div>
          )}
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'indexdb' ? (
        <IndexedDBInspector />
      ) : (
        <>
          <h2 className="text-2xl font-bold text-white mb-2">Vector Search</h2>
          <p className="text-slate-300 text-sm mb-4">
            Search your memories using AI-powered semantic similarity
          </p>

          {/* Debug Logs */}
          {debugLogs.length > 0 && (
            <div className="mb-6 bg-slate-900/50 border border-slate-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-slate-300">🐛 Debug Logs</h3>
                <button
                  onClick={() => setDebugLogs([])}
                  className="text-xs text-slate-400 hover:text-slate-300"
                >
                  Clear
                </button>
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {debugLogs.map((log, i) => (
                  <div key={i} className="text-xs font-mono text-slate-400">
                    {log}
                  </div>
                ))}
              </div>
            </div>
          )}

      {/* Search Input */}
      <div className="space-y-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-2">
            Search Query
          </label>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g., 'trip to Paris' or 'TypeScript projects'"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          {query.length > 0 && query.length < 3 && (
            <p className="text-xs text-yellow-400 mt-1">
              Enter at least 3 characters to search
            </p>
          )}
        </div>

        {/* Settings */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Min Similarity ({minSimilarity.toFixed(2)})
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={minSimilarity}
              onChange={(e) => setMinSimilarity(parseFloat(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-slate-400 mt-1">
              <span>Less strict</span>
              <span>More strict</span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Result Count
            </label>
            <select
              value={resultCount}
              onChange={(e) => setResultCount(parseInt(e.target.value))}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="3">3 results</option>
              <option value="5">5 results</option>
              <option value="10">10 results</option>
              <option value="20">20 results</option>
            </select>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="space-y-4">
        {isLoading && query.length >= 3 && (
          <div className="text-center py-8">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
            <p className="text-slate-300 mt-2">Searching memories...</p>
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-500/20 border border-red-500/50 rounded-lg">
            <p className="text-sm text-red-300">Error: {error.message}</p>
          </div>
        )}

        {!isLoading && query.length >= 3 && results && results.length === 0 && (
          <div className="text-center py-8">
            <p className="text-slate-300">
              No memories found matching your search.
            </p>
            <p className="text-slate-400 text-sm mt-2">
              Try lowering the similarity threshold or using different keywords.
            </p>
            <p className="text-slate-400 text-sm mt-3">
              💡 Tip: Make sure you've added some memories first using the "Add Memory" section above.
            </p>
          </div>
        )}

        {results && results.length > 0 && (
          <>
            <div className="text-sm text-slate-400 mb-2">
              Found {results.length} {results.length === 1 ? 'memory' : 'memories'}
            </div>
            {results.map((result, idx) => (
              <div
                key={result.blobId || idx}
                className="bg-white/5 border border-white/10 rounded-lg p-4 hover:bg-white/10 transition-colors"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <h3 className="font-semibold text-white mb-1">
                      {result.category || 'Uncategorized'}
                    </h3>
                    {/* Rich Metadata: Topic */}
                    {result.topic && result.topic !== 'memory' && (
                      <div className="text-sm text-blue-300 mb-2">
                        📌 {result.topic}
                      </div>
                    )}
                    <div className="flex items-center gap-3 text-xs text-slate-400">
                      <span>
                        Similarity: {(result.similarity * 100).toFixed(1)}%
                      </span>
                      {result.importance !== undefined && (
                        <span className="text-yellow-400">
                          ⭐ {result.importance}/10
                        </span>
                      )}
                      {result.timestamp && (
                        <span>
                          {new Date(result.timestamp).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      result.similarity >= 0.8
                        ? 'bg-green-500/20 text-green-300'
                        : result.similarity >= 0.6
                        ? 'bg-yellow-500/20 text-yellow-300'
                        : 'bg-slate-500/20 text-slate-300'
                    }`}
                  >
                    {result.similarity >= 0.8
                      ? 'High match'
                      : result.similarity >= 0.6
                      ? 'Good match'
                      : 'Fair match'}
                  </div>
                </div>

                {/* Rich Metadata: Summary */}
                {result.summary && (
                  <div className="text-sm text-slate-300 bg-blue-500/10 rounded p-3 border border-blue-500/20 mb-2 italic">
                    💬 {result.summary}
                  </div>
                )}

                <div className="text-sm text-slate-200 bg-white/5 rounded p-3 border border-white/10 mt-2">
                  {result.content || 'No content available'}
                </div>

                <div className="flex items-center justify-between mt-2">
                  <div className="text-xs text-slate-500 font-mono break-all">
                    Blob: {result.blobId?.substring(0, 32)}...
                  </div>
                  {/* Show embedding type indicator */}
                  {result.embeddingType === 'metadata' && (
                    <div className="text-xs bg-purple-500/20 text-purple-300 px-2 py-1 rounded">
                      🔒 Metadata-indexed
                    </div>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {!query && (
          <div className="text-center py-8 text-slate-400">
            Enter a search query to find similar memories
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}
