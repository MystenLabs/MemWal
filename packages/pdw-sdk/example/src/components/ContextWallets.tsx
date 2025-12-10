'use client';

import { useState, useEffect, useMemo } from 'react';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { ContextWalletService, MainWalletService } from 'personal-data-wallet-sdk';

export function ContextWallets() {
  const account = useCurrentAccount();
  const client = useSuiClient();

  const [contexts, setContexts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create context form state
  const [newContextName, setNewContextName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Initialize MainWalletService
  const mainWalletService = useMemo(() => {
    if (!client) return null;
    return new MainWalletService({
      suiClient: client as any,
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID || '',
    });
  }, [client]);

  // Initialize ContextWalletService
  const contextService = useMemo(() => {
    if (!client || !mainWalletService) return null;
    return new ContextWalletService({
      suiClient: client as any,
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID || '',
      mainWalletService,
    });
  }, [client, mainWalletService]);

  // Load contexts
  useEffect(() => {
    if (!account?.address || !contextService) return;

    const loadContexts = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const userContexts = await contextService.listUserContexts(account.address);
        setContexts(userContexts || []);
      } catch (err: any) {
        console.error('Failed to load contexts:', err);
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    loadContexts();
  }, [account?.address, contextService]);

  const handleCreateContext = async () => {
    if (!newContextName.trim() || !account || !contextService) return;

    setIsCreating(true);
    setError(null);

    try {
      // TODO: Need signer to create context
      // await contextService.create(newContextName, signer);
      console.log('Create context:', newContextName);
      alert('Context creation requires wallet signing - will be implemented in next version');

      setNewContextName('');
      // Refresh contexts list
      // const updated = await contextService.listUserContexts(account.address);
      // setContexts(updated || []);
    } catch (err: any) {
      console.error('Failed to create context:', err);
      setError(err.message);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
      <h2 className="text-2xl font-bold text-white mb-2">Context Wallets</h2>
      <p className="text-slate-300 text-sm mb-6">
        Isolate data into separate contexts (work, personal, health, etc.)
      </p>

      {error && (
        <div className="mb-4 p-4 bg-red-500/20 border border-red-500/50 rounded-lg">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Create Context Form */}
      <div className="mb-8 p-4 bg-white/5 border border-white/10 rounded-lg">
        <h3 className="text-lg font-semibold text-white mb-4">Create New Context</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Context Name
            </label>
            <input
              type="text"
              value={newContextName}
              onChange={(e) => setNewContextName(e.target.value)}
              placeholder="e.g., 'Work', 'Personal', 'Health'"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="text-xs text-slate-400 mt-2">
              Contexts provide data isolation with separate encryption keys
            </p>
          </div>

          <button
            onClick={handleCreateContext}
            disabled={!newContextName.trim() || isCreating}
            className="w-full bg-primary/20 hover:bg-primary/30 disabled:bg-slate-600 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            {isCreating ? 'Creating...' : 'Create Context'}
          </button>
        </div>
      </div>

      {/* Contexts List */}
      <div>
        <h3 className="text-lg font-semibold text-white mb-4">
          Your Contexts ({contexts.length})
        </h3>

        {isLoading ? (
          <div className="text-center py-8">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
            <p className="text-slate-300 mt-2">Loading contexts...</p>
          </div>
        ) : contexts.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <p className="mb-2">No context wallets yet</p>
            <p className="text-sm">
              Create contexts to organize your memories by category
            </p>

            {/* Example contexts */}
            <div className="mt-6 grid grid-cols-3 gap-4">
              <div className="bg-white/5 border border-white/10 rounded-lg p-4">
                <div className="text-4xl mb-2">💼</div>
                <div className="text-sm text-white font-medium">Work</div>
                <div className="text-xs text-slate-400 mt-1">
                  Professional memories
                </div>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-lg p-4">
                <div className="text-4xl mb-2">🏠</div>
                <div className="text-sm text-white font-medium">Personal</div>
                <div className="text-xs text-slate-400 mt-1">
                  Private life
                </div>
              </div>
              <div className="bg-white/5 border border-white/10 rounded-lg p-4">
                <div className="text-4xl mb-2">🏥</div>
                <div className="text-sm text-white font-medium">Health</div>
                <div className="text-xs text-slate-400 mt-1">
                  Medical records
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {contexts.map((context, idx) => (
              <div
                key={context.id || idx}
                className="bg-white/5 border border-white/10 rounded-lg p-4 hover:bg-white/10 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h4 className="font-semibold text-white text-lg mb-2">
                      {context.name || 'Unnamed Context'}
                    </h4>

                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <div className="text-slate-400">Context ID</div>
                        <div className="text-slate-300 font-mono text-xs">
                          {context.id?.substring(0, 10)}...
                          {context.id?.substring(context.id.length - 8)}
                        </div>
                      </div>

                      <div>
                        <div className="text-slate-400">Memory Count</div>
                        <div className="text-slate-300">
                          {context.memoryCount || 0} memories
                        </div>
                      </div>

                      <div>
                        <div className="text-slate-400">Created</div>
                        <div className="text-slate-300">
                          {context.createdAt
                            ? new Date(context.createdAt).toLocaleDateString()
                            : 'Unknown'}
                        </div>
                      </div>

                      <div>
                        <div className="text-slate-400">Last Activity</div>
                        <div className="text-slate-300">
                          {context.lastActivity
                            ? new Date(context.lastActivity).toLocaleDateString()
                            : 'No activity'}
                        </div>
                      </div>
                    </div>

                    {context.description && (
                      <div className="mt-3 text-sm text-slate-400">
                        {context.description}
                      </div>
                    )}
                  </div>

                  <div className="ml-4 flex flex-col gap-2">
                    <button className="text-sm text-blue-400 hover:text-blue-300">
                      View Data
                    </button>
                    <button className="text-sm text-slate-400 hover:text-slate-300">
                      Settings
                    </button>
                  </div>
                </div>

                {/* Data Isolation Info */}
                <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded text-xs">
                  <div className="text-blue-300 font-medium mb-1">
                    🔒 Data Isolation Active
                  </div>
                  <div className="text-slate-400">
                    This context has separate encryption keys. Data cannot be accessed
                    from other contexts.
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Key Derivation Info */}
      <div className="mt-6 p-4 bg-white/5 border border-white/10 rounded-lg">
        <h4 className="text-sm font-semibold text-white mb-2">
          How Context Wallets Work
        </h4>
        <ul className="space-y-2 text-sm text-slate-300">
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>Each context has a unique derived key from your main wallet</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>Memories in one context cannot access data from another</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>Perfect for separating work, personal, and sensitive data</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>Key rotation supported for security</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
