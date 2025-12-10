'use client';

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useKnowledgeGraph } from 'personal-data-wallet-sdk/hooks';

export function KnowledgeGraph() {
  const account = useCurrentAccount();
  const [searchKeyword, setSearchKeyword] = useState('');
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

  const { searchGraph, findRelated, graph, stats, isLoading, error } = useKnowledgeGraph(account?.address);

  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [relatedEntities, setRelatedEntities] = useState<any[]>([]);

  const handleSearch = async () => {
    if (!searchKeyword.trim()) return;

    const results = await searchGraph({
      keywords: [searchKeyword],
    });

    setSearchResults(Array.isArray(results) ? results : (results as any)?.entities || []);
  };

  const handleFindRelated = async (entityId: string) => {
    setSelectedEntityId(entityId);
    const related = await findRelated(entityId, 2); // 2 hops
    setRelatedEntities(related || []);
  };

  // Show connection prompt if wallet not connected
  if (!account?.address) {
    return (
      <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
        <h2 className="text-2xl font-bold text-white mb-2">Knowledge Graph</h2>
        <div className="text-center py-12">
          <p className="text-slate-300 mb-4">
            Please connect your wallet to view Knowledge Graph
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
      <h2 className="text-2xl font-bold text-white mb-2">Knowledge Graph</h2>
      <p className="text-slate-300 text-sm mb-6">
        AI-extracted entities and relationships from your memories
      </p>

      {/* Graph Statistics */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white/5 border border-white/10 rounded-lg p-4">
            <div className="text-2xl font-bold text-white">{stats.totalEntities || 0}</div>
            <div className="text-sm text-slate-400">Entities</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-lg p-4">
            <div className="text-2xl font-bold text-white">{stats.totalRelationships || 0}</div>
            <div className="text-sm text-slate-400">Relationships</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-lg p-4">
            <div className="text-2xl font-bold text-white">{stats.sourceMemories || 0}</div>
            <div className="text-sm text-slate-400">Memories</div>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-slate-300 mb-2">
          Search Entities
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search by keyword (e.g., 'Paris', 'project')"
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            onClick={handleSearch}
            disabled={!searchKeyword.trim() || isLoading}
            className="bg-primary/20 hover:bg-primary/30 disabled:bg-slate-600 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Search
          </button>
        </div>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
          <p className="text-slate-300 mt-2">Loading graph...</p>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="p-4 bg-red-500/20 border border-red-500/50 rounded-lg mb-6">
          <p className="text-sm text-red-300">Error: {error.message}</p>
        </div>
      )}

      {/* Search Results */}
      {searchResults.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-white mb-3">
            Search Results ({searchResults.length})
          </h3>
          <div className="space-y-2">
            {searchResults.map((entity, idx) => (
              <div
                key={entity.id || idx}
                className="bg-white/5 border border-white/10 rounded-lg p-4 hover:bg-white/10 transition-colors cursor-pointer"
                onClick={() => handleFindRelated(entity.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <h4 className="font-semibold text-white">{entity.name || entity.label}</h4>
                    <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                      <span className="px-2 py-1 bg-blue-500/20 text-blue-300 rounded">
                        {entity.type || 'Unknown'}
                      </span>
                      {entity.properties && Object.keys(entity.properties).length > 0 && (
                        <span>{Object.keys(entity.properties).length} properties</span>
                      )}
                    </div>
                  </div>
                  <button className="text-xs text-primary hover:text-primary/80">
                    Find Related →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Related Entities */}
      {relatedEntities.length > 0 && selectedEntityId && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-white mb-3">
            Related Entities ({relatedEntities.length})
          </h3>
          <div className="space-y-2">
            {relatedEntities.map((entity, idx) => (
              <div
                key={entity.id || idx}
                className="bg-white/5 border border-white/10 rounded-lg p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h4 className="font-semibold text-white">{entity.name || entity.label}</h4>
                    <div className="flex items-center gap-3 text-xs text-slate-400 mt-1">
                      <span className="px-2 py-1 bg-purple-500/20 text-purple-300 rounded">
                        {entity.type || 'Unknown'}
                      </span>
                      {entity.relationship && (
                        <span className="text-slate-500">
                          via "{entity.relationship}"
                        </span>
                      )}
                    </div>
                    {entity.properties && (
                      <div className="mt-2 text-xs text-slate-400">
                        {Object.entries(entity.properties).slice(0, 3).map(([key, value]) => (
                          <div key={key}>
                            <span className="text-slate-500">{key}:</span> {String(value)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All Entities (if graph loaded) */}
      {graph && graph.entities && graph.entities.length > 0 && !searchResults.length && (
        <div>
          <h3 className="text-lg font-semibold text-white mb-3">
            All Entities ({graph.entities.length})
          </h3>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {graph.entities.slice(0, 50).map((entity: any, idx) => (
              <div
                key={entity.id || idx}
                className="bg-white/5 border border-white/10 rounded-lg p-3 hover:bg-white/10 transition-colors cursor-pointer"
                onClick={() => handleFindRelated(entity.id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-white">{entity.name || entity.label}</span>
                    <span className="ml-2 px-2 py-1 bg-green-500/20 text-green-300 rounded text-xs">
                      {entity.type || 'Unknown'}
                    </span>
                  </div>
                  <button className="text-xs text-primary hover:text-primary/80">
                    Explore →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !graph?.entities?.length && (
        <div className="text-center py-12 text-slate-400">
          <p className="mb-2">No knowledge graph data yet</p>
          <p className="text-sm">
            Create memories to automatically extract entities and relationships
          </p>
        </div>
      )}
    </div>
  );
}
