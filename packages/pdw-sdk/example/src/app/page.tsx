'use client';

import { useState } from 'react';
import { ConnectButton, useCurrentAccount } from '@mysten/dapp-kit';
import { CreateMemory } from '@/components/CreateMemory';
import { MemoryList } from '@/components/MemoryList';
import { RetrieveMemory } from '@/components/RetrieveMemory';
import { SearchMemory } from '@/components/SearchMemory';
import { MemoryChat } from '@/components/MemoryChat';
import { KnowledgeGraph } from '@/components/KnowledgeGraph';
import { AccessControl } from '@/components/AccessControl';
import { ContextWallets } from '@/components/ContextWallets';

type Tab = 'create' | 'list' | 'retrieve' | 'search' | 'chat' | 'graph' | 'access' | 'contexts';

export default function Home() {
  const account = useCurrentAccount();
  const [activeTab, setActiveTab] = useState<Tab>('create');

  const tabs = [
    { id: 'create' as Tab, label: 'Create', icon: '➕' },
    { id: 'list' as Tab, label: 'List', icon: '📋' },
    { id: 'retrieve' as Tab, label: 'Retrieve', icon: '🔍' },
    { id: 'search' as Tab, label: 'Vector Search', icon: '🎯' },
    { id: 'chat' as Tab, label: 'AI Chat', icon: '💬' },
    { id: 'graph' as Tab, label: 'Knowledge Graph', icon: '🕸️' },
    { id: 'access' as Tab, label: 'Access Control', icon: '🔐' },
    { id: 'contexts' as Tab, label: 'Contexts', icon: '📁' },
  ];

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <header className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-4xl font-bold text-white mb-2">
                Personal Data Wallet
              </h1>
              <p className="text-slate-300">
                Decentralized memory system with AI embeddings, SEAL encryption and Walrus storage
              </p>
            </div>
            <ConnectButton />
          </div>
        </header>

        {!account ? (
          <div className="flex items-center justify-center min-h-[400px]">
            <div className="text-center">
              <h2 className="text-2xl font-semibold text-white mb-4">
                Connect Your Wallet
              </h2>
              <p className="text-slate-300 mb-8">
                Please connect your Sui wallet to start using Personal Data Wallet
              </p>
              <ConnectButton />
            </div>
          </div>
        ) : (
          <>
            {/* Tabs Navigation */}
            <div className="mb-6 bg-white/5 backdrop-blur-lg rounded-lg p-2 border border-white/10">
              <div className="flex flex-wrap gap-2">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                      activeTab === tab.id
                        ? 'bg-primary/30 text-white border border-primary/50'
                        : 'bg-white/5 text-slate-300 hover:bg-white/10 border border-transparent'
                    }`}
                  >
                    <span>{tab.icon}</span>
                    <span className="font-medium">{tab.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Tab Content */}
            <div className="transition-all duration-300">
              {activeTab === 'create' && <CreateMemory />}
              {activeTab === 'list' && <MemoryList />}
              {activeTab === 'retrieve' && <RetrieveMemory />}
              {activeTab === 'search' && <SearchMemory />}
              {activeTab === 'chat' && <MemoryChat />}
              {activeTab === 'graph' && <KnowledgeGraph />}
              {activeTab === 'access' && <AccessControl />}
              {activeTab === 'contexts' && <ContextWallets />}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
