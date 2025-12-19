/**
 * React Hooks Example: Using PDW LangChain Integration in React
 *
 * This example demonstrates:
 * 1. Using usePDWVectorStore hook to initialize vector store
 * 2. Using usePDWRAG hook for complete RAG functionality
 * 3. Adding documents to the vector store
 * 4. Querying the RAG system with natural language
 *
 * Requirements:
 * - React 18+
 * - @mysten/dapp-kit for Sui wallet integration
 * - GEMINI_API_KEY environment variable
 *
 * Setup:
 * ```bash
 * npm install react react-dom @mysten/dapp-kit @langchain/google-genai
 * ```
 */

import React, { useState } from 'react';
import { usePDWVectorStore, usePDWRAG } from 'personal-data-wallet-sdk/hooks';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';

// ============================================================================
// Example 1: Simple RAG Application
// ============================================================================

export function SimpleRAGApp() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();
  const client = useSuiClient();
  const [query, setQuery] = useState('');

  // Initialize LLM
  const llm = new ChatGoogleGenerativeAI({
    modelName: 'gemini-2.0-flash-exp',
    apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
  });

  // Initialize RAG with usePDWRAG hook
  const {
    query: performQuery,
    isProcessing,
    answer,
    sources,
    error,
    isReady,
    clear
  } = usePDWRAG({
    vectorStoreOptions: {
      userAddress: account?.address || '',
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
      accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID,
      walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
      geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    },
    llm,
    systemPrompt: 'You are a helpful assistant. Use the provided context to answer questions accurately.',
    k: 5,
    minSimilarity: 0.5,
    includeSources: true,
  });

  const handleQuery = async () => {
    if (!query.trim()) return;
    await performQuery(query);
  };

  if (!account) {
    return (
      <div className="p-4">
        <p>Please connect your wallet to use the RAG system.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">PDW RAG System</h1>

      {/* Status indicator */}
      <div className="mb-4">
        {!isReady && <p className="text-yellow-600">Initializing RAG system...</p>}
        {isReady && <p className="text-green-600">Ready to answer questions</p>}
        {error && <p className="text-red-600">Error: {error.message}</p>}
      </div>

      {/* Query input */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">
          Ask a question:
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleQuery()}
            placeholder="What would you like to know?"
            className="flex-1 px-4 py-2 border rounded-lg"
            disabled={!isReady || isProcessing}
          />
          <button
            onClick={handleQuery}
            disabled={!isReady || isProcessing}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg disabled:bg-gray-400"
          >
            {isProcessing ? 'Processing...' : 'Ask'}
          </button>
        </div>
      </div>

      {/* Answer display */}
      {answer && (
        <div className="bg-gray-50 rounded-lg p-4 mb-4">
          <h2 className="font-semibold mb-2">Answer:</h2>
          <p className="whitespace-pre-wrap">{answer}</p>

          {/* Sources display */}
          {sources && sources.length > 0 && (
            <div className="mt-4 pt-4 border-t">
              <h3 className="font-semibold text-sm mb-2">Sources:</h3>
              <ul className="space-y-2">
                {sources.map((source, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-medium">#{i + 1}:</span> {source.pageContent}
                    {source.metadata?.category && (
                      <span className="ml-2 text-gray-500">
                        ({source.metadata.category})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            onClick={clear}
            className="mt-4 text-sm text-blue-600 hover:underline"
          >
            Clear answer
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Example 2: Advanced Vector Store Management
// ============================================================================

export function VectorStoreManager() {
  const account = useCurrentAccount();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();
  const client = useSuiClient();
  const [newDocument, setNewDocument] = useState('');
  const [category, setCategory] = useState('general');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);

  // Initialize vector store with usePDWVectorStore hook
  const {
    vectorStore,
    embeddings,
    isReady,
    error,
    reinitialize
  } = usePDWVectorStore({
    userAddress: account?.address || '',
    packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
    accessRegistryId: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID,
    walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    defaultCategory: 'general',
  });

  // Add document to vector store
  const handleAddDocument = async () => {
    if (!vectorStore || !account || !newDocument.trim()) return;

    setIsAdding(true);
    try {
      const blobIds = await vectorStore.addDocuments(
        [{ pageContent: newDocument, metadata: { category } }],
        {
          account,
          signAndExecute: (params, callbacks) => {
            signAndExecute(params, {
              onSuccess: callbacks.onSuccess,
              onError: callbacks.onError,
            });
          },
          client,
          category,
          onProgress: (status) => console.log(status),
        }
      );

      console.log('Document added:', blobIds);
      setNewDocument('');
      alert('Document added successfully!');
    } catch (err) {
      console.error('Failed to add document:', err);
      alert('Failed to add document. Check console for details.');
    } finally {
      setIsAdding(false);
    }
  };

  // Search documents
  const handleSearch = async () => {
    if (!vectorStore || !searchQuery.trim()) return;

    try {
      const results = await vectorStore.similaritySearchWithScore(searchQuery, 5);
      setSearchResults(results);
    } catch (err) {
      console.error('Search failed:', err);
      alert('Search failed. Check console for details.');
    }
  };

  // Get vector store stats
  const handleGetStats = async () => {
    if (!vectorStore) return;

    try {
      const stats = await vectorStore.getStats();
      console.log('Vector Store Stats:', stats);
      alert(JSON.stringify(stats, null, 2));
    } catch (err) {
      console.error('Failed to get stats:', err);
    }
  };

  if (!account) {
    return (
      <div className="p-4">
        <p>Please connect your wallet to manage the vector store.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">Vector Store Manager</h1>

      {/* Status */}
      <div className="mb-6">
        {!isReady && <p className="text-yellow-600">Initializing vector store...</p>}
        {isReady && <p className="text-green-600">Vector store ready</p>}
        {error && (
          <div className="text-red-600">
            <p>Error: {error.message}</p>
            <button onClick={reinitialize} className="text-sm underline">
              Retry initialization
            </button>
          </div>
        )}
      </div>

      {/* Add document */}
      <div className="mb-6 p-4 border rounded-lg">
        <h2 className="text-lg font-semibold mb-3">Add Document</h2>
        <textarea
          value={newDocument}
          onChange={(e) => setNewDocument(e.target.value)}
          placeholder="Enter document content..."
          className="w-full px-4 py-2 border rounded-lg mb-2"
          rows={4}
          disabled={!isReady || isAdding}
        />
        <div className="flex gap-2 mb-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-4 py-2 border rounded-lg"
            disabled={!isReady || isAdding}
          >
            <option value="general">General</option>
            <option value="work">Work</option>
            <option value="personal">Personal</option>
            <option value="research">Research</option>
          </select>
          <button
            onClick={handleAddDocument}
            disabled={!isReady || isAdding || !newDocument.trim()}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg disabled:bg-gray-400"
          >
            {isAdding ? 'Adding...' : 'Add Document'}
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="mb-6 p-4 border rounded-lg">
        <h2 className="text-lg font-semibold mb-3">Search Documents</h2>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search for similar documents..."
            className="flex-1 px-4 py-2 border rounded-lg"
            disabled={!isReady}
          />
          <button
            onClick={handleSearch}
            disabled={!isReady || !searchQuery.trim()}
            className="px-6 py-2 bg-green-600 text-white rounded-lg disabled:bg-gray-400"
          >
            Search
          </button>
        </div>

        {/* Search results */}
        {searchResults.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-semibold text-sm">Results:</h3>
            {searchResults.map(([doc, score], i) => (
              <div key={i} className="p-3 bg-gray-50 rounded">
                <div className="flex justify-between items-start mb-1">
                  <span className="font-medium text-sm">#{i + 1}</span>
                  <span className="text-sm text-gray-600">
                    Score: {score.toFixed(3)}
                  </span>
                </div>
                <p className="text-sm">{doc.pageContent}</p>
                {doc.metadata?.category && (
                  <span className="text-xs text-gray-500">
                    Category: {doc.metadata.category}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="p-4 border rounded-lg">
        <button
          onClick={handleGetStats}
          disabled={!isReady}
          className="px-6 py-2 bg-purple-600 text-white rounded-lg disabled:bg-gray-400"
        >
          Get Vector Store Stats
        </button>
        <p className="text-sm text-gray-600 mt-2">
          Check console for detailed statistics
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Example 3: Conversational RAG with Chat History
// ============================================================================

export function ConversationalRAGApp() {
  const account = useCurrentAccount();
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');

  // Initialize LLM
  const llm = new ChatGoogleGenerativeAI({
    modelName: 'gemini-2.0-flash-exp',
    apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
  });

  // Initialize RAG
  const {
    query: performQuery,
    isProcessing,
    answer,
    isReady,
    clear
  } = usePDWRAG({
    vectorStoreOptions: {
      userAddress: account?.address || '',
      packageId: process.env.NEXT_PUBLIC_PACKAGE_ID!,
      walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
      geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
    },
    llm,
    systemPrompt: 'You are a helpful conversational assistant. Use the context and chat history to provide accurate answers.',
    k: 5,
  });

  const handleSend = async () => {
    if (!input.trim()) return;

    // Add user message
    const userMessage = { role: 'user' as const, content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');

    // Query RAG system
    await performQuery(input);
  };

  // Add assistant answer to messages when it's ready
  React.useEffect(() => {
    if (answer) {
      setMessages(prev => [...prev, { role: 'assistant', content: answer }]);
    }
  }, [answer]);

  if (!account) {
    return (
      <div className="p-4">
        <p>Please connect your wallet to start chatting.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 h-screen flex flex-col">
      <h1 className="text-2xl font-bold mb-4">Conversational RAG Chat</h1>

      {/* Status */}
      {!isReady && <p className="text-yellow-600 mb-4">Initializing chat system...</p>}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto mb-4 space-y-3 p-4 bg-gray-50 rounded-lg">
        {messages.length === 0 && (
          <p className="text-gray-500 text-center">
            Start a conversation by asking a question below
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`p-3 rounded-lg ${
              msg.role === 'user'
                ? 'bg-blue-100 ml-auto max-w-[80%]'
                : 'bg-white mr-auto max-w-[80%]'
            }`}
          >
            <p className="text-sm font-semibold mb-1">
              {msg.role === 'user' ? 'You' : 'Assistant'}
            </p>
            <p className="whitespace-pre-wrap">{msg.content}</p>
          </div>
        ))}
        {isProcessing && (
          <div className="p-3 rounded-lg bg-white mr-auto max-w-[80%]">
            <p className="text-sm font-semibold mb-1">Assistant</p>
            <p className="text-gray-500">Thinking...</p>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Ask a question..."
          className="flex-1 px-4 py-2 border rounded-lg"
          disabled={!isReady || isProcessing}
        />
        <button
          onClick={handleSend}
          disabled={!isReady || isProcessing}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg disabled:bg-gray-400"
        >
          Send
        </button>
        {messages.length > 0 && (
          <button
            onClick={() => {
              setMessages([]);
              clear();
            }}
            className="px-6 py-2 bg-gray-600 text-white rounded-lg"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
