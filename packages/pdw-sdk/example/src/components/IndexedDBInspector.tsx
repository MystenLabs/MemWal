'use client';

import { useState, useEffect } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';

interface IndexData {
  userAddress: string;
  version: number;
  lastUpdated: number;
  metadata: Record<string, any>;
  vectorCount?: number;
}

interface VectorData {
  vectorId: number;
  metadata: any;
  timestamp: number;
  hasVector: boolean;
}

export function IndexedDBInspector() {
  const account = useCurrentAccount();
  const [indexData, setIndexData] = useState<IndexData | null>(null);
  const [vectors, setVectors] = useState<VectorData[]>([]);
  const [emscriptenFiles, setEmscriptenFiles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const inspectIndexedDB = async () => {
    if (!account?.address) return;

    setIsLoading(true);
    setError(null);

    try {
      // 1. Open the HNSW index database
      // ✅ FIX: Use correct database name 'HnswIndexDB' (not 'HNSWIndexStorage')
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('HnswIndexDB', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          // Database doesn't exist yet - will be created on first memory
          console.log('Database HnswIndexDB does not exist yet');
        };
      });

      // Check if database has the required object stores
      if (!db.objectStoreNames.contains('indices')) {
        console.log('📋 Database exists but no object stores yet (no memories created)');
        db.close();
        setIndexData(null);
        setVectors([]);
        setEmscriptenFiles([]);
        setLastRefresh(new Date());
        setIsLoading(false);
        return;
      }

      // 2. Get index data for current user
      const transaction = db.transaction(['indices'], 'readonly');
      const store = transaction.objectStore('indices');
      const getRequest = store.get(account.address);

      const data = await new Promise<IndexData | null>((resolve) => {
        getRequest.onsuccess = () => resolve(getRequest.result || null);
        getRequest.onerror = () => resolve(null);
      });

      setIndexData(data);

      // 3. Try to get vectors (if vectors object store exists)
      try {
        if (!db.objectStoreNames.contains('vectors')) {
          console.log('📋 No vectors object store (vectors stored in batched format)');
          setVectors([]);
        } else {
          const vectorTransaction = db.transaction(['vectors'], 'readonly');
          const vectorStore = vectorTransaction.objectStore('vectors');
          const vectorRequest = vectorStore.getAll();

        const allVectors = await new Promise<any[]>((resolve) => {
          vectorRequest.onsuccess = () => resolve(vectorRequest.result || []);
          vectorRequest.onerror = () => resolve([]);
        });

        // Filter vectors for current user
        const userVectors = allVectors
          .filter((v: any) => v.userAddress === account.address)
          .map((v: any) => ({
            vectorId: v.vectorId,
            metadata: v.metadata,
            timestamp: v.timestamp,
            hasVector: Array.isArray(v.vector) && v.vector.length > 0
          }))
          .sort((a, b) => b.timestamp - a.timestamp); // Newest first

          setVectors(userVectors);
        }
      } catch (vectorError) {
        console.log('No vectors object store (using batched storage)');
        setVectors([]);
      }

      db.close();

      // 4. Check Emscripten FS (IDBFS)
      try {
        const emscriptenDb = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('/emscripten', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          request.onupgradeneeded = () => {
            console.log('Emscripten database does not exist yet');
          };
        });

        // Check if FILE_DATA store exists
        if (!emscriptenDb.objectStoreNames.contains('FILE_DATA')) {
          console.log('📋 Emscripten database exists but no FILE_DATA store yet');
          emscriptenDb.close();
          setEmscriptenFiles([]);
          setLastRefresh(new Date());
          setIsLoading(false);
          return;
        }

        const emscriptenTx = emscriptenDb.transaction(['FILE_DATA'], 'readonly');
        const emscriptenStore = emscriptenTx.objectStore('FILE_DATA');
        const filesRequest = emscriptenStore.getAllKeys();

        const files = await new Promise<string[]>((resolve) => {
          filesRequest.onsuccess = () => {
            const keys = filesRequest.result || [];
            resolve(keys.map(k => String(k)));
          };
          filesRequest.onerror = () => resolve([]);
        });

        console.log(`📁 Found ${files.length} files in Emscripten IDBFS:`, files);

        // Filter for user's HNSW files
        const userFiles = files.filter(f =>
          f.includes(account.address.substring(0, 10)) ||
          f.includes('hnsw')
        );
        setEmscriptenFiles(userFiles);

        emscriptenDb.close();
      } catch (emscriptenError) {
        console.log('📋 No Emscripten IDBFS found (normal if WASM not used yet)');
        setEmscriptenFiles([]);
      }

      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || 'Failed to inspect IndexedDB');
      console.error('IndexedDB inspection error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-refresh on mount and when account changes
  useEffect(() => {
    if (account?.address) {
      inspectIndexedDB();
    }
  }, [account?.address]);

  if (!account?.address) {
    return (
      <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
        <h2 className="text-2xl font-bold text-white mb-4">IndexedDB Inspector</h2>
        <div className="text-center py-8">
          <p className="text-slate-300 mb-4">
            Please connect your wallet to inspect IndexedDB storage
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-2">IndexedDB Inspector</h2>
          <p className="text-slate-300 text-sm">
            Browser-local storage for HNSW vector index
          </p>
        </div>
        <button
          onClick={inspectIndexedDB}
          disabled={isLoading}
          className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/50 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
        >
          {isLoading ? (
            <>
              <div className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              Refreshing...
            </>
          ) : (
            <>
              🔄 Refresh
            </>
          )}
        </button>
      </div>

      {/* Last Refresh Time */}
      {lastRefresh && (
        <div className="text-xs text-slate-400 mb-4">
          Last updated: {lastRefresh.toLocaleTimeString()}
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="mb-4 p-4 bg-red-500/20 border border-red-500/50 rounded-lg">
          <p className="text-sm text-red-300">❌ {error}</p>
        </div>
      )}

      {/* Storage Location Info */}
      <div className="mb-6 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
        <h3 className="font-semibold text-blue-300 mb-2 flex items-center gap-2">
          💾 Storage Location
        </h3>
        <div className="text-sm text-slate-300 space-y-1">
          <p>📍 <strong>Type:</strong> Browser IndexedDB (Client-side only)</p>
          <p>👤 <strong>User:</strong> {account.address.substring(0, 10)}...{account.address.substring(account.address.length - 8)}</p>
          <p>🌐 <strong>Origin:</strong> {typeof window !== 'undefined' ? window.location.origin : 'N/A'}</p>
          <p className="text-xs text-slate-400 mt-2">
            ⚠️ Data is stored locally in your browser and is NOT synced across devices
          </p>
        </div>
      </div>

      {/* Index Data */}
      <div className="space-y-4">
        {/* Show "no data yet" message if database doesn't exist */}
        {!indexData && !isLoading && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 mb-4">
            <h3 className="font-semibold text-yellow-300 mb-2 flex items-center gap-2">
              📋 No Data Yet
            </h3>
            <p className="text-sm text-slate-300 mb-2">
              The IndexedDB database hasn't been created yet because no memories have been indexed.
            </p>
            <p className="text-sm text-slate-400">
              💡 <strong>To create the database:</strong>
            </p>
            <ol className="text-sm text-slate-400 mt-2 space-y-1 list-decimal list-inside">
              <li>Go to the "Add Memory" section above</li>
              <li>Create your first memory</li>
              <li>Return here and click "🔄 Refresh" to see the indexed data</li>
            </ol>
          </div>
        )}

        <div className="bg-white/5 border border-white/10 rounded-lg p-4">
          <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
            📊 Index Metadata
          </h3>
          {indexData ? (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Version:</span>
                <span className="text-white font-mono">{indexData.version}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Last Updated:</span>
                <span className="text-white">
                  {new Date(indexData.lastUpdated).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Metadata Entries:</span>
                <span className="text-white">
                  {Object.keys(indexData.metadata || {}).length}
                </span>
              </div>
              {indexData.metadata && Object.keys(indexData.metadata).length > 0 && (
                <div className="mt-3 p-3 bg-white/5 rounded border border-white/10">
                  <div className="text-xs text-slate-400 mb-2">
                    Stored Metadata ({Object.keys(indexData.metadata).length} vector{Object.keys(indexData.metadata).length !== 1 ? 's' : ''}):
                  </div>
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {Object.entries(indexData.metadata).map(([vectorId, meta]: [string, any]) => (
                      <div key={vectorId} className="p-2 bg-white/5 rounded border border-white/10">
                        <div className="flex justify-between items-start mb-1">
                          <span className="text-xs text-slate-400">Vector ID:</span>
                          <span className="text-xs text-white font-mono">{vectorId}</span>
                        </div>
                        {meta.blobId && (
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-xs text-slate-400">Blob ID:</span>
                            <span className="text-xs text-slate-300 font-mono break-all">
                              {meta.blobId.length > 40 ? meta.blobId.substring(0, 32) + '...' : meta.blobId}
                            </span>
                          </div>
                        )}
                        {meta.category && (
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-xs text-slate-400">Category:</span>
                            <span className="text-xs text-green-300">{meta.category}</span>
                          </div>
                        )}
                        {/* Rich Metadata: Topic */}
                        {meta.topic && (
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-xs text-slate-400">Topic:</span>
                            <span className="text-xs text-blue-300">
                              {meta.topic === 'memory' ? '⚠️ Default (old)' : `📌 ${meta.topic}`}
                            </span>
                          </div>
                        )}
                        {meta.importance !== undefined && (
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-xs text-slate-400">Importance:</span>
                            <span className="text-xs text-yellow-300">⭐ {meta.importance}/10</span>
                          </div>
                        )}
                        {/* Rich Metadata: Summary */}
                        {meta.summary && (
                          <div className="col-span-2 mb-1">
                            <div className="text-xs text-slate-400 mb-1">Summary:</div>
                            <div className="text-xs text-slate-300 bg-blue-500/10 rounded p-2 border border-blue-500/20 italic">
                              💬 {meta.summary}
                            </div>
                          </div>
                        )}
                        {/* Rich Metadata: Embedding Type */}
                        {meta.embeddingType && (
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-xs text-slate-400">Embedding Type:</span>
                            <span className={`text-xs ${meta.embeddingType === 'metadata' ? 'text-purple-300' : 'text-slate-300'}`}>
                              {meta.embeddingType === 'metadata' ? '🔒 Metadata-based' : meta.embeddingType}
                            </span>
                          </div>
                        )}
                        {meta.createdTimestamp && (
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-xs text-slate-400">Created:</span>
                            <span className="text-xs text-slate-300">
                              {new Date(meta.createdTimestamp).toLocaleString()}
                            </span>
                          </div>
                        )}
                        {meta.source && (
                          <div className="flex justify-between items-start">
                            <span className="text-xs text-slate-400">Source:</span>
                            <span className="text-xs text-blue-300">{meta.source}</span>
                          </div>
                        )}
                        {/* Show if this is test data */}
                        {meta.blobId === 'test-blob' && (
                          <div className="mt-2 pt-2 border-t border-yellow-500/30">
                            <span className="text-xs text-yellow-400">⚠️ This is test data from debug page</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-slate-400 text-sm">
              No index found for this user. Create a memory to initialize the index.
            </p>
          )}
        </div>

        {/* Vector Data */}
        <div className="bg-white/5 border border-white/10 rounded-lg p-4">
          <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
            🎯 Indexed Vectors
          </h3>
          {vectors.length > 0 ? (
            <div className="space-y-2">
              <div className="text-sm text-slate-300 mb-3">
                Found {vectors.length} vector{vectors.length !== 1 ? 's' : ''} in storage
              </div>
              <div className="max-h-64 overflow-y-auto space-y-2">
                {vectors.map((vector) => (
                  <div
                    key={vector.vectorId}
                    className="p-3 bg-white/5 rounded border border-white/10 text-sm"
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-slate-400">Vector ID:</span>
                      <span className="text-white font-mono">{vector.vectorId}</span>
                    </div>
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-slate-400">Timestamp:</span>
                      <span className="text-white text-xs">
                        {new Date(vector.timestamp).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between items-start">
                      <span className="text-slate-400">Has Vector:</span>
                      <span className={vector.hasVector ? 'text-green-400' : 'text-red-400'}>
                        {vector.hasVector ? '✅ Yes' : '❌ No'}
                      </span>
                    </div>
                    {vector.metadata && (
                      <div className="mt-2 pt-2 border-t border-white/10">
                        <div className="text-xs text-slate-400 mb-1">Metadata:</div>
                        <div className="text-xs text-slate-300 space-y-1">
                          {vector.metadata.category && (
                            <div>Category: {vector.metadata.category}</div>
                          )}
                          {vector.metadata.topic && (
                            <div className="text-blue-300">
                              📌 Topic: {vector.metadata.topic === 'memory' ? '⚠️ Default (old)' : vector.metadata.topic}
                            </div>
                          )}
                          {vector.metadata.importance !== undefined && (
                            <div className="text-yellow-300">⭐ Importance: {vector.metadata.importance}/10</div>
                          )}
                          {vector.metadata.summary && (
                            <div className="bg-blue-500/10 rounded p-2 border border-blue-500/20 italic">
                              💬 {vector.metadata.summary}
                            </div>
                          )}
                          {vector.metadata.embeddingType && (
                            <div className={vector.metadata.embeddingType === 'metadata' ? 'text-purple-300' : ''}>
                              {vector.metadata.embeddingType === 'metadata' ? '🔒 Metadata-based embedding' : `Embedding: ${vector.metadata.embeddingType}`}
                            </div>
                          )}
                          {vector.metadata.blobId && (
                            <div className="font-mono break-all">
                              Blob: {vector.metadata.blobId.substring(0, 32)}...
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-slate-400 text-sm">
              No vectors stored yet. Vectors are added when you create memories.
            </p>
          )}
        </div>

        {/* Emscripten IDBFS Files */}
        <div className="bg-white/5 border border-white/10 rounded-lg p-4">
          <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
            🗂️ WASM Index Files (Emscripten FS)
          </h3>
          {emscriptenFiles.length > 0 ? (
            <div className="space-y-2">
              <div className="text-sm text-slate-300 mb-3">
                Found {emscriptenFiles.length} file{emscriptenFiles.length !== 1 ? 's' : ''} in Emscripten IDBFS
              </div>
              <div className="space-y-1">
                {emscriptenFiles.map((file, idx) => (
                  <div
                    key={idx}
                    className="p-2 bg-white/5 rounded border border-white/10 text-xs font-mono text-slate-300 break-all"
                  >
                    {file}
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-3">
                💡 These are HNSW index binary files stored by hnswlib-wasm
              </p>
            </div>
          ) : (
            <p className="text-slate-400 text-sm">
              No Emscripten files found. Index files are created when you add vectors.
            </p>
          )}
        </div>

        {/* How to Clear Data */}
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
          <h3 className="font-semibold text-yellow-300 mb-2 flex items-center gap-2">
            🧹 Clear IndexedDB Data
          </h3>
          <p className="text-sm text-slate-300 mb-3">
            To clear local browser storage:
          </p>
          <ol className="text-sm text-slate-300 space-y-1 list-decimal list-inside">
            <li>Open Browser DevTools (F12)</li>
            <li>Go to "Application" tab</li>
            <li>Click "Storage" → "Clear site data"</li>
          </ol>
          <p className="text-xs text-slate-400 mt-3">
            ⚠️ This will clear ALL browser data including the HNSW index
          </p>
        </div>
      </div>
    </div>
  );
}
