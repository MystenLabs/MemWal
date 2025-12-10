/**
 * usePDWRAG - React Hook for RAG with PDWVectorStore
 *
 * Convenience hook for building RAG applications in React.
 * Combines usePDWVectorStore with RAG chain creation.
 *
 * @example
 * ```typescript
 * import { usePDWRAG } from 'personal-data-wallet-sdk/hooks';
 * import { useCurrentAccount } from '@mysten/dapp-kit';
 * import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
 *
 * function MyRAGApp() {
 *   const account = useCurrentAccount();
 *   const llm = new ChatGoogleGenerativeAI({ apiKey: geminiApiKey });
 *
 *   const { query, isProcessing, answer, sources, error } = usePDWRAG({
 *     userAddress: account?.address,
 *     packageId: '0x...',
 *     geminiApiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY!,
 *     llm,
 *   });
 *
 *   const handleAsk = () => {
 *     query('What did I do last week?');
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleAsk} disabled={isProcessing}>
 *         Ask AI
 *       </button>
 *       {answer && <p>{answer}</p>}
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useCallback } from 'react';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseMessage } from '@langchain/core/messages';
import { usePDWVectorStore, type UsePDWVectorStoreOptions } from './usePDWVectorStore';
import { createPDWRAG, createPDWRAGWithSources } from '../langchain/createPDWRAG';
import type { PDWRAGConfig } from '../langchain/createPDWRAG';

export interface UsePDWRAGOptions extends UsePDWVectorStoreOptions {
  /**
   * LangChain LLM for generation (any chat model like ChatOpenAI, ChatAnthropic, ChatGoogleGenerativeAI, etc.)
   */
  llm: Runnable<any, BaseMessage>;

  /**
   * System prompt for the RAG chain
   */
  systemPrompt?: string;

  /**
   * Number of documents to retrieve
   * @default 5
   */
  k?: number;

  /**
   * Minimum similarity threshold
   * @default 0.5
   */
  minSimilarity?: number;

  /**
   * Whether to return source documents
   * @default false
   */
  returnSourceDocuments?: boolean;

  /**
   * Metadata filters for retrieval
   */
  filter?: Record<string, any>;
}

export interface UsePDWRAGReturn {
  /**
   * Query function - ask a question
   */
  query: (question: string) => Promise<void>;

  /**
   * Whether a query is currently processing
   */
  isProcessing: boolean;

  /**
   * Latest answer from the RAG chain
   */
  answer: string | null;

  /**
   * Source documents (if returnSourceDocuments is true)
   */
  sources: Array<{
    content: string;
    metadata: any;
    similarity?: number;
  }> | null;

  /**
   * Error if query failed
   */
  error: Error | null;

  /**
   * Whether the RAG system is ready
   */
  isReady: boolean;

  /**
   * Clear current answer and sources
   */
  clear: () => void;
}

/**
 * React hook for RAG with PDWVectorStore
 *
 * Combines vector store initialization with RAG chain creation
 * and provides a simple query interface.
 */
export function usePDWRAG(options: UsePDWRAGOptions): UsePDWRAGReturn {
  const {
    llm,
    systemPrompt,
    k = 5,
    minSimilarity = 0.5,
    returnSourceDocuments = false,
    filter,
    ...vectorStoreOptions
  } = options;

  // Initialize vector store
  const { vectorStore, isReady: vectorStoreReady, error: vectorStoreError } =
    usePDWVectorStore(vectorStoreOptions);

  // Query state
  const [isProcessing, setIsProcessing] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<any[] | null>(null);
  const [error, setError] = useState<Error | null>(vectorStoreError);

  // Query function
  const query = useCallback(
    async (question: string) => {
      if (!vectorStore || !vectorStoreReady) {
        setError(new Error('Vector store not ready'));
        return;
      }

      setIsProcessing(true);
      setError(null);

      try {
        const ragConfig: PDWRAGConfig = {
          vectorStore,
          llm,
          systemPrompt,
          k,
          minSimilarity,
          filter,
        };

        if (returnSourceDocuments) {
          // Use RAG with sources
          const chain = await createPDWRAGWithSources(ragConfig);
          const result = await chain.invoke({ question });

          if (typeof result === 'object' && 'answer' in result) {
            setAnswer(result.answer);
            setSources(result.sourceDocuments || null);
          } else {
            setAnswer(String(result));
            setSources(null);
          }
        } else {
          // Use regular RAG
          const chain = await createPDWRAG(ragConfig);
          const result = await chain.invoke({ question });
          setAnswer(String(result));
          setSources(null);
        }
      } catch (err) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        setError(errorObj);
        setAnswer(null);
        setSources(null);
      } finally {
        setIsProcessing(false);
      }
    },
    [vectorStore, vectorStoreReady, llm, systemPrompt, k, minSimilarity, returnSourceDocuments, filter]
  );

  // Clear function
  const clear = useCallback(() => {
    setAnswer(null);
    setSources(null);
    setError(null);
  }, []);

  return {
    query,
    isProcessing,
    answer,
    sources,
    error: error || vectorStoreError,
    isReady: vectorStoreReady && !isProcessing,
    clear,
  };
}
