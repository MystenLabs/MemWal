'use client';

import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { useMemoryChat } from 'personal-data-wallet-sdk/hooks';

export function MemoryChat() {
  const account = useCurrentAccount();
  const [inputMessage, setInputMessage] = useState('');

  const {
    messages,
    sendMessage,
    createMemoryFromMessage,
    isProcessing,
    retrievedMemories,
  } = useMemoryChat(account?.address, {
    systemPrompt: 'You are a helpful AI assistant with access to the user\'s personal memories. Use relevant memories to provide contextual and personalized responses.',
    maxContextMemories: 5,
    aiProvider: 'gemini',
    autoSaveMessages: false, // User can manually save important messages
    geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY,
  });

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || isProcessing) return;

    await sendMessage(inputMessage);
    setInputMessage('');
  };

  const handleSaveMessage = async (messageIndex: number) => {
    const message = messages[messageIndex];
    if (message && message.role === 'user') {
      await createMemoryFromMessage(message.content);
    }
  };

  // Show connection prompt if wallet not connected
  if (!account?.address) {
    return (
      <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl h-[700px] flex flex-col">
        <h2 className="text-2xl font-bold text-white mb-2">Memory Chat (RAG)</h2>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-slate-300 mb-4">
              Please connect your wallet to use Memory Chat
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/10 backdrop-blur-lg rounded-lg p-6 shadow-xl h-[700px] flex flex-col">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-white mb-2">Memory Chat (RAG)</h2>
        <p className="text-slate-300 text-sm">
          AI chat with context from your memories - demonstrates Retrieval-Augmented Generation
        </p>
      </div>

      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-2">
        {messages.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <p className="mb-2">Start a conversation!</p>
            <p className="text-sm">
              Your memories will be automatically retrieved to provide context.
            </p>
          </div>
        ) : (
          messages.map((message, idx) => (
            <div
              key={idx}
              className={`flex ${
                message.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[80%] rounded-lg p-4 ${
                  message.role === 'user'
                    ? 'bg-primary/20 border border-primary/30'
                    : 'bg-white/5 border border-white/10'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-slate-400">
                    {message.role === 'user' ? 'You' : 'AI Assistant'}
                  </span>
                  {message.role === 'user' && (
                    <button
                      onClick={() => handleSaveMessage(idx)}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      Save as Memory
                    </button>
                  )}
                </div>
                <div className="text-sm text-white whitespace-pre-wrap">
                  {message.content}
                </div>
                {message.timestamp && (
                  <div className="text-xs text-slate-500 mt-2">
                    {new Date(message.timestamp).toLocaleTimeString()}
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {isProcessing && (
          <div className="flex justify-start">
            <div className="bg-white/5 border border-white/10 rounded-lg p-4">
              <div className="flex items-center space-x-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                <span className="text-sm text-slate-300">AI is thinking...</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Retrieved Memories Context */}
      {retrievedMemories && retrievedMemories.length > 0 && (
        <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <div className="text-xs font-medium text-blue-300 mb-2">
            Using {retrievedMemories.length} {retrievedMemories.length === 1 ? 'memory' : 'memories'} for context:
          </div>
          <div className="space-y-1">
            {retrievedMemories.map((memory, idx) => (
              <div key={idx} className="text-xs text-slate-300 truncate">
                • {memory.category}: {memory.content?.substring(0, 50)}...
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="flex gap-2">
        <input
          type="text"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
          placeholder="Ask me anything about your memories..."
          disabled={isProcessing}
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
        />
        <button
          onClick={handleSendMessage}
          disabled={!inputMessage.trim() || isProcessing}
          className="bg-primary/20 hover:bg-primary/30 disabled:bg-slate-600 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-medium transition-colors"
        >
          Send
        </button>
      </div>

      {/* Info */}
      <div className="mt-3 text-xs text-slate-400 text-center">
        Messages are stored in browser. Click "Save as Memory" to persist important messages.
      </div>
    </div>
  );
}
