/**
 * createPDWRAG - Simple RAG Helper for Personal Data Wallet
 *
 * A one-function RAG setup that combines PDWVectorStore with any LangChain LLM.
 * Provides the quickest way to build RAG applications with decentralized storage.
 *
 * @example
 * ```typescript
 * import { createPDWRAG, PDWEmbeddings, PDWVectorStore } from 'personal-data-wallet-sdk/langchain';
 * import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
 *
 * const embeddings = new PDWEmbeddings({ geminiApiKey });
 * const vectorStore = new PDWVectorStore(embeddings, config);
 * const llm = new ChatGoogleGenerativeAI({ apiKey: geminiApiKey });
 *
 * const ragChain = await createPDWRAG({
 *   vectorStore,
 *   llm,
 *   systemPrompt: 'You are my personal AI assistant.'
 * });
 *
 * const answer = await ragChain.invoke({ question: 'What did I do last week?' });
 * ```
 */

import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import type { Runnable } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { VectorStoreRetriever } from '@langchain/core/vectorstores';
import type { BaseMessage } from '@langchain/core/messages';
import type { PDWVectorStore } from './PDWVectorStore';

export interface PDWRAGConfig {
  /**
   * PDWVectorStore instance for retrieval
   */
  vectorStore: PDWVectorStore;

  /**
   * LangChain LLM for generation
   * Can be any LLM: ChatGoogleGenerativeAI, ChatOpenAI, ChatAnthropic, etc.
   */
  llm: Runnable<any, BaseMessage>;

  /**
   * System prompt for the RAG chain
   * @default 'You are a helpful assistant with access to a knowledge base.'
   */
  systemPrompt?: string;

  /**
   * Number of documents to retrieve
   * @default 5
   */
  k?: number;

  /**
   * Minimum similarity threshold (0-1)
   * @default 0.5
   */
  minSimilarity?: number;

  /**
   * Custom retriever (overrides vectorStore if provided)
   */
  retriever?: VectorStoreRetriever;

  /**
   * Custom prompt template (overrides systemPrompt)
   */
  promptTemplate?: ChatPromptTemplate;

  /**
   * Whether to include source documents in the output
   * @default false
   */
  returnSourceDocuments?: boolean;

  /**
   * Metadata filters for retrieval
   */
  filter?: Record<string, any>;
}

export interface PDWRAGResult {
  /**
   * Generated answer from the LLM
   */
  answer: string;

  /**
   * Source documents used for context (if returnSourceDocuments is true)
   */
  sourceDocuments?: Array<{
    content: string;
    metadata: any;
    similarity?: number;
  }>;
}

/**
 * Create a RAG chain with PDWVectorStore
 *
 * This helper function sets up a complete RAG pipeline:
 * 1. Retriever: Fetches relevant documents from PDWVectorStore
 * 2. Prompt: Formats context and question for the LLM
 * 3. LLM: Generates answer based on context
 * 4. Parser: Extracts text from LLM response
 *
 * @param config - RAG configuration
 * @returns A runnable chain that takes { question: string } and returns answer
 */
export async function createPDWRAG(
  config: PDWRAGConfig
): Promise<RunnableSequence> {
  const {
    vectorStore,
    llm,
    systemPrompt = 'You are a helpful assistant with access to a knowledge base. Use the following context to answer questions accurately.',
    k = 5,
    minSimilarity = 0.5,
    retriever: customRetriever,
    promptTemplate,
    filter,
  } = config;

  // Create retriever from vector store or use custom
  const retriever = customRetriever || vectorStore.asRetriever({
    k,
    filter: {
      ...filter,
      minSimilarity,
    },
  });

  // Create prompt template
  const prompt = promptTemplate || ChatPromptTemplate.fromTemplate(`
${systemPrompt}

Context from your knowledge base:
{context}

Question: {question}

Answer based on the context above. If the context doesn't contain relevant information, say so.
  `);

  // Build RAG chain
  const ragChain = RunnableSequence.from([
    {
      context: async (input: { question: string }) => {
        const docs = await retriever.invoke(input.question);
        return docs.map(d => d.pageContent).join('\n\n');
      },
      question: (input: { question: string }) => input.question,
    },
    prompt,
    llm,
    new StringOutputParser(),
  ]);

  return ragChain;
}

/**
 * Create a RAG chain that returns both answer and source documents
 *
 * @param config - RAG configuration with returnSourceDocuments enabled
 * @returns A runnable chain that returns { answer, sourceDocuments }
 */
export async function createPDWRAGWithSources(
  config: Omit<PDWRAGConfig, 'returnSourceDocuments'>
): Promise<RunnableSequence> {
  const {
    vectorStore,
    llm,
    systemPrompt = 'You are a helpful assistant with access to a knowledge base.',
    k = 5,
    minSimilarity = 0.5,
    retriever: customRetriever,
    promptTemplate,
    filter,
  } = config;

  // Create retriever
  const retriever = customRetriever || vectorStore.asRetriever({
    k,
    filter: {
      ...filter,
      minSimilarity,
    },
  });

  // Create prompt template
  const prompt = promptTemplate || ChatPromptTemplate.fromTemplate(`
${systemPrompt}

Context:
{context}

Question: {question}

Answer:
  `);

  // Build RAG chain with sources
  const ragChain = RunnableSequence.from([
    async (input: { question: string }) => {
      const docs = await retriever.invoke(input.question);

      return {
        context: docs.map(d => d.pageContent).join('\n\n'),
        question: input.question,
        sourceDocuments: docs.map(d => ({
          content: d.pageContent,
          metadata: d.metadata,
          similarity: d.metadata?.similarity,
        })),
      };
    },
    async (input: any) => {
      const answer = await RunnableSequence.from([
        {
          context: () => input.context,
          question: () => input.question,
        },
        prompt,
        llm,
        new StringOutputParser(),
      ]).invoke(input);

      return {
        answer,
        sourceDocuments: input.sourceDocuments,
      };
    },
  ]);

  return ragChain;
}

/**
 * Create a conversational RAG chain that maintains chat history
 *
 * @param config - RAG configuration
 * @returns A runnable chain that takes { question, chatHistory } and returns answer
 */
export async function createConversationalPDWRAG(
  config: PDWRAGConfig
): Promise<RunnableSequence> {
  const {
    vectorStore,
    llm,
    systemPrompt = 'You are a helpful assistant with access to a knowledge base.',
    k = 5,
    minSimilarity = 0.5,
    retriever: customRetriever,
    filter,
  } = config;

  // Create retriever
  const retriever = customRetriever || vectorStore.asRetriever({
    k,
    filter: {
      ...filter,
      minSimilarity,
    },
  });

  // Create conversational prompt
  const prompt = ChatPromptTemplate.fromTemplate(`
${systemPrompt}

Chat History:
{chatHistory}

Context from knowledge base:
{context}

Current Question: {question}

Answer:
  `);

  // Build conversational RAG chain
  const ragChain = RunnableSequence.from([
    {
      context: async (input: { question: string; chatHistory?: string }) => {
        const docs = await retriever.invoke(input.question);
        return docs.map(d => d.pageContent).join('\n\n');
      },
      question: (input: { question: string; chatHistory?: string }) => input.question,
      chatHistory: (input: { question: string; chatHistory?: string }) =>
        input.chatHistory || 'No previous messages',
    },
    prompt,
    llm,
    new StringOutputParser(),
  ]);

  return ragChain;
}
