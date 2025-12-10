'use client';

import { useState, useEffect, useMemo } from 'react';
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { ViewService } from 'personal-data-wallet-sdk';

export function AccessControl() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const [permissions, setPermissions] = useState<any[]>([]);
  const [memories, setMemories] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Grant permission form state
  const [selectedMemoryId, setSelectedMemoryId] = useState('');
  const [granteeAddress, setGranteeAddress] = useState('');
  const [permissionType, setPermissionType] = useState('read');
  const [expirationDays, setExpirationDays] = useState(30);

  // Initialize ViewService
  const viewService = useMemo(() => {
    if (!client) return null;
    return new ViewService(client as any, {
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID || '',
    });
  }, [client]);

  // Load permissions and memories
  useEffect(() => {
    if (!account?.address || !viewService) return;

    const loadData = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Load user's permissions
        const perms = await viewService.getAccessPermissions(account.address, {
          asGrantor: true,
          activeOnly: false,
        });
        setPermissions(perms);

        // Load user's memories for permission granting
        const mems = await viewService.getUserMemories(account.address, {
          limit: 50,
        });
        setMemories(mems.data);
      } catch (err: any) {
        console.error('Failed to load access control data:', err);
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [account?.address, viewService]);

  const handleGrantPermission = async () => {
    if (!selectedMemoryId || !granteeAddress) {
      setError('Please select a memory and enter a grantee address');
      return;
    }

    setError(null);
    // TODO: Implement grant permission transaction
    console.log('Grant permission:', {
      memoryId: selectedMemoryId,
      grantee: granteeAddress,
      type: permissionType,
      expires: expirationDays,
    });

    // For now, show success message
    alert('Permission granting will be implemented in the next version');
  };

  const handleRevokePermission = async (permissionId: string) => {
    setError(null);
    // TODO: Implement revoke permission transaction
    console.log('Revoke permission:', permissionId);
    alert('Permission revoking will be implemented in the next version');
  };

  return (
    <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl">
      <h2 className="text-2xl font-bold text-white mb-2">Access Control</h2>
      <p className="text-slate-300 text-sm mb-6">
        Grant and manage access permissions for your memories
      </p>

      {error && (
        <div className="mb-4 p-4 bg-red-500/20 border border-red-500/50 rounded-lg">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Grant Permission Form */}
      <div className="mb-8 p-4 bg-white/5 border border-white/10 rounded-lg">
        <h3 className="text-lg font-semibold text-white mb-4">Grant New Permission</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Select Memory
            </label>
            <select
              value={selectedMemoryId}
              onChange={(e) => setSelectedMemoryId(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">Choose a memory...</option>
              {memories.map((memory) => (
                <option key={memory.id} value={memory.id}>
                  {memory.category} - {new Date(memory.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Grantee Address
            </label>
            <input
              type="text"
              value={granteeAddress}
              onChange={(e) => setGranteeAddress(e.target.value)}
              placeholder="0x..."
              className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Permission Type
              </label>
              <select
                value={permissionType}
                onChange={(e) => setPermissionType(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Expires In (Days)
              </label>
              <input
                type="number"
                value={expirationDays}
                onChange={(e) => setExpirationDays(parseInt(e.target.value))}
                min="1"
                max="365"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>

          <button
            onClick={handleGrantPermission}
            disabled={!selectedMemoryId || !granteeAddress}
            className="w-full bg-primary/20 hover:bg-primary/30 disabled:bg-slate-600 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-medium transition-colors"
          >
            Grant Permission
          </button>
        </div>
      </div>

      {/* Active Permissions List */}
      <div>
        <h3 className="text-lg font-semibold text-white mb-4">
          Active Permissions ({permissions.length})
        </h3>

        {isLoading ? (
          <div className="text-center py-8">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
            <p className="text-slate-300 mt-2">Loading permissions...</p>
          </div>
        ) : permissions.length === 0 ? (
          <div className="text-center py-8 text-slate-400">
            <p>No permissions granted yet</p>
            <p className="text-sm mt-2">
              Grant permissions to share your memories with others
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {permissions.map((permission) => (
              <div
                key={permission.id}
                className="bg-white/5 border border-white/10 rounded-lg p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span
                        className={`px-2 py-1 rounded text-xs font-medium ${
                          permission.isActive
                            ? 'bg-green-500/20 text-green-300'
                            : 'bg-red-500/20 text-red-300'
                        }`}
                      >
                        {permission.isActive ? 'Active' : 'Expired'}
                      </span>
                      <span className="px-2 py-1 bg-blue-500/20 text-blue-300 rounded text-xs font-medium">
                        {permission.permissionType}
                      </span>
                    </div>

                    <div className="space-y-1 text-sm text-slate-300">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500">Grantee:</span>
                        <span className="font-mono">
                          {permission.grantee.substring(0, 10)}...
                          {permission.grantee.substring(permission.grantee.length - 8)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500">Content:</span>
                        <span className="font-mono">
                          {permission.contentId.substring(0, 10)}...
                        </span>
                      </div>
                      {permission.expiresAt && (
                        <div className="flex items-center gap-2">
                          <span className="text-slate-500">Expires:</span>
                          <span>
                            {new Date(permission.expiresAt).toLocaleDateString()}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {permission.isActive && (
                    <button
                      onClick={() => handleRevokePermission(permission.id)}
                      className="text-sm text-red-400 hover:text-red-300"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
