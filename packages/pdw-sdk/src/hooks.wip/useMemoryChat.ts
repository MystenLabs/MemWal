/**
 * useMemoryChat - Complete memory-aware chat hook with context retrieval
 *
 * Drop-in solution for building memory-aware chatbots with AI integration.
 *
 * @example
 * ```tsx
 * import { useMemoryChat } from 'personal-data-wallet-sdk/hooks';
 * import { useCurrentAccount } from '@mysten/dapp-kit';
 *
 * function ChatInterface() {
 *   const account = useCurrentAccount();
 *
 *   const {
 *     messages,
 *     sendMessage,
 *     createMemoryFromMessage,
 *     isProcessing,
 *     retrievedMemories
 *   } = useMemoryChat(account?.address, {
 *     systemPrompt: 'You are a helpful assistant with access to user memories.',
 *     maxContextMemories: 5,
 *     aiProvider: 'gemini'
 *   });
 *
 *   return (
 *     <div>
 *       {messages.map((msg, i) => (
 *         <div key={i} className={msg.role}>
 *           {msg.content}
 *           {msg.memories && (
 *             <div className="context">
 *               Used {msg.memories.length} memories
 *             </div>
 *           )}
 *         </div>
 *       ))}
 *
 *       <button onClick={() => sendMessage('Hello!')}>
 *         Send Message
 *       </button>
 *
 *       <button onClick={() => createMemoryFromMessage('Save this')}>
 *         💾 Remember this
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction, useSignPersonalMessage } from '@mysten/dapp-kit';
import { useMemorySearch } from './useMemorySearch';
import { useCreateMemory } from './useCreateMemory';
import { useMemoryManager } from './useMemoryManager';
import type {
  ChatMessage,
  MemoryChatConfig,
  SearchMemoryResult,
  MemoryManagerConfig,
} from './utils/types';

export interface UseMemoryChatOptions extends MemoryChatConfig {
  /**
   * Optional memory manager config
   */
  config?: MemoryManagerConfig;

  /**
   * Session ID for chat history persistence
   */
  sessionId?: string;

  /**
   * Auto-save messages as memories
   * @default false
   */
  autoSaveMessages?: boolean;

  /**
   * Gemini API key for embeddings
   */
  geminiApiKey?: string;
}

export interface UseMemoryChatReturn {
  /**
   * All chat messages
   */
  messages: ChatMessage[];

  /**
   * Send a message and get AI response
   */
  sendMessage: (content: string) => Promise<void>;

  /**
   * Create a memory from message content
   */
  createMemoryFromMessage: (content: string) => Promise<void>;

  /**
   * Whether the chat is processing (searching/generating response)
   */
  isProcessing: boolean;

  /**
   * Currently retrieved memories for context
   */
  retrievedMemories: SearchMemoryResult[];

  /**
   * Clear chat history
   */
  clearHistory: () => void;

  /**
   * Error if any
   */
  error: Error | null;
}

/**
 * Hook for memory-aware chat with AI integration
 */
export function useMemoryChat(
  userAddress: string | undefined,
  options: UseMemoryChatOptions = {}
): UseMemoryChatReturn {
  const {
    systemPrompt = 'You are a helpful assistant with access to user memories.',
    maxContextMemories = 5,
    aiProvider = 'gemini',
    streamResponses = false,
    config,
    sessionId = 'default',
    autoSaveMessages = false,
    geminiApiKey,
  } = options;

  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();
  const { mutateAsync: signMessage } = useSignPersonalMessage();
  const manager = useMemoryManager(config);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [retrievedMemories, setRetrievedMemories] = useState<SearchMemoryResult[]>([]);
  const [error, setError] = useState<Error | null>(null);

  // Memory search hook with API key config
  const { search, results: searchResults } = useMemorySearch(
    userAddress,
    geminiApiKey ? { geminiApiKey } : undefined
  );

  // Create memory hook
  const { mutateAsync: createMemory } = useCreateMemory({ config });

  // Load chat history from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && sessionId) {
      try {
        const stored = localStorage.getItem(`chat_${sessionId}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          setMessages(
            parsed.map((msg: any) => ({
              ...msg,
              timestamp: new Date(msg.timestamp),
            }))
          );
        }
      } catch (err) {
        console.warn('Failed to load chat history:', err);
      }
    }
  }, [sessionId]);

  // Save chat history to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined' && sessionId && messages.length > 0) {
      try {
        localStorage.setItem(`chat_${sessionId}`, JSON.stringify(messages));
      } catch (err) {
        console.warn('Failed to save chat history:', err);
      }
    }
  }, [messages, sessionId]);

  /**
   * Generate embedding and search for relevant memories
   */
  const retrieveContext = useCallback(
    async (query: string): Promise<SearchMemoryResult[]> => {
      try {
        // Search memories
        await search(query, {
          k: maxContextMemories,
          threshold: 0.5,
        });

        // Convert searchResults to array if needed
        if (!searchResults || !Array.isArray(searchResults)) {
          return [];
        }

        return searchResults.slice(0, maxContextMemories).map(result => ({
          blobId: result.blobId,
          content: result.content,
          category: result.category,
          similarity: result.similarity,
          timestamp: new Date(result.timestamp || Date.now()),
          embedding: result.embedding,
        }));
      } catch (err) {
        console.error('Failed to retrieve context:', err);
        return [];
      }
    },
    [search, searchResults, maxContextMemories]
  );

  /**
   * Call AI API with context
   */
  const generateAIResponse = useCallback(
    async (userMessage: string, context: SearchMemoryResult[]): Promise<string> => {
      // Build context from memories
      const contextText = context
        .map(
          (mem, i) =>
            `Memory ${i + 1} (similarity: ${mem.similarity.toFixed(2)}):\n${mem.content}`
        )
        .join('\n\n');

      const prompt = `${systemPrompt}

${contextText ? `Relevant memories from the user:\n${contextText}\n\n` : ''}User message: ${userMessage}`;

      try {
        // Call AI API based on provider
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: aiProvider,
            messages: [
              ...messages.map((msg) => ({
                role: msg.role,
                content: msg.content,
              })),
              { role: 'user', content: prompt },
            ],
            stream: streamResponses,
          }),
        });

        if (!response.ok) {
          throw new Error(`AI API failed: ${response.statusText}`);
        }

        const data = await response.json();
        return data.response || data.message || 'No response from AI';
      } catch (err) {
        console.error('AI API error:', err);
        throw new Error('Failed to generate AI response');
      }
    },
    [systemPrompt, aiProvider, messages, streamResponses]
  );

  /**
   * Send a message and get AI response
   */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;
      if (isProcessing) return;

      setIsProcessing(true);
      setError(null);

      try {
        // Add user message
        const userMessage: ChatMessage = {
          role: 'user',
          content,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, userMessage]);

        // Retrieve relevant memories
        const context = await retrieveContext(content);
        setRetrievedMemories(context);

        // Generate AI response
        const aiResponse = await generateAIResponse(content, context);

        // Add AI message with memory references
        const aiMessage: ChatMessage = {
          role: 'assistant',
          content: aiResponse,
          timestamp: new Date(),
          memories: context.length > 0 ? context : undefined,
        };
        setMessages((prev) => [...prev, aiMessage]);

        // Auto-save message as memory if enabled
        if (autoSaveMessages && account && client) {
          try {
            await createMemory({ content, category: 'chat' });
          } catch (err) {
            console.warn('Failed to auto-save message:', err);
          }
        }
      } catch (err) {
        console.error('Chat error:', err);
        setError(err as Error);

        // Add error message
        const errorMessage: ChatMessage = {
          role: 'assistant',
          content: `Sorry, I encountered an error: ${(err as Error).message}`,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsProcessing(false);
      }
    },
    [
      isProcessing,
      retrieveContext,
      generateAIResponse,
      autoSaveMessages,
      account,
      client,
      signAndExecute,
      createMemory,
    ]
  );

  /**
   * Create a memory from message content
   */
  const createMemoryFromMessage = useCallback(
    async (content: string) => {
      if (!content.trim()) return;
      if (!account || !client) {
        throw new Error('Wallet not connected');
      }

      try {
        await createMemory({
          content,
          category: 'chat',
        });

        // Add confirmation message
        const confirmationMessage: ChatMessage = {
          role: 'system',
          content: '💾 Memory saved successfully!',
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, confirmationMessage]);
      } catch (err) {
        console.error('Failed to create memory:', err);
        throw err;
      }
    },
    [account, client, signAndExecute, createMemory]
  );

  /**
   * Clear chat history
   */
  const clearHistory = useCallback(() => {
    setMessages([]);
    setRetrievedMemories([]);
    setError(null);

    if (typeof window !== 'undefined' && sessionId) {
      localStorage.removeItem(`chat_${sessionId}`);
    }
  }, [sessionId]);

  return {
    messages,
    sendMessage,
    createMemoryFromMessage,
    isProcessing,
    retrievedMemories,
    clearHistory,
    error,
  };
}

export default useMemoryChat;
