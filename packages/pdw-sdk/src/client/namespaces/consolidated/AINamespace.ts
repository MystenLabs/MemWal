/**
 * AI Namespace - Consolidated AI Features
 *
 * Merges functionality from:
 * - EmbeddingsNamespace: Vector embedding generation
 * - ClassifyNamespace: Content classification & analysis
 * - ChatNamespace: AI chat with memory context
 *
 * Provides a unified interface for all AI-powered operations.
 *
 * @module client/namespaces/consolidated
 */

import type { ServiceContainer } from '../../SimplePDWClient';

// ============================================================================
// Types
// ============================================================================

/**
 * Pattern analysis result
 */
export interface PatternAnalysis {
  patterns: Array<{
    type: string;
    confidence: number;
    examples: string[];
  }>;
  categories: string[];
  suggestedCategory: string;
}

/**
 * Classification result with full details
 */
export interface ClassificationResult {
  shouldSave: boolean;
  confidence: number;
  category: string;
  reasoning: string;
}

/**
 * Chat session
 */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/**
 * Chat message
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

/**
 * Embedding options
 */
export interface EmbedOptions {
  type?: 'query' | 'document';
}

/**
 * Chat sub-namespace for chat operations
 */
class ChatSubNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Create a new chat session
   *
   * @param options - Session options
   * @returns Created session
   *
   * @example
   * ```typescript
   * const session = await pdw.ai.chat.createSession({ title: 'Work Discussion' });
   * ```
   */
  async createSession(options?: { title?: string; model?: string }): Promise<ChatSession> {
    const result = await this.services.chat.createSession({
      userAddress: this.services.config.userAddress,
      modelName: options?.model || process.env.AI_CHAT_MODEL || 'google/gemini-2.5-flash',
      title: options?.title || 'New Chat'
    });
    return result.session as any as ChatSession;
  }

  /**
   * Get chat session by ID
   *
   * @param sessionId - Session ID
   * @returns Session with messages
   */
  async get(sessionId: string): Promise<ChatSession> {
    const result = await this.services.chat.getSession(
      sessionId,
      this.services.config.userAddress
    );
    return result.session as any as ChatSession;
  }

  /**
   * Get all user sessions
   *
   * @returns Array of sessions
   */
  async list(): Promise<ChatSession[]> {
    const result = await this.services.chat.getSessions(
      this.services.config.userAddress
    );
    return result.sessions as any as ChatSession[];
  }

  /**
   * Send message (non-streaming)
   *
   * @param sessionId - Session ID
   * @param message - Message text
   * @returns AI response
   *
   * @example
   * ```typescript
   * const response = await pdw.ai.chat.send(sessionId, 'What do you remember about TypeScript?');
   * console.log(response.content);
   * ```
   */
  async send(sessionId: string, message: string): Promise<ChatMessage> {
    const result = await this.services.chat.sendMessage({
      text: message,
      userId: this.services.config.userAddress,
      userAddress: this.services.config.userAddress,
      sessionId
    });

    return {
      role: 'assistant' as const,
      content: result.content || '',
      timestamp: Date.now()
    };
  }

  /**
   * Stream chat response
   *
   * @param sessionId - Session ID
   * @param message - Message text
   * @param callbacks - Streaming callbacks
   *
   * @example
   * ```typescript
   * await pdw.ai.chat.stream(sessionId, 'Tell me about my preferences', {
   *   onMessage: (chunk) => process.stdout.write(chunk.data),
   *   onDone: () => console.log('\nDone!')
   * });
   * ```
   */
  async stream(
    sessionId: string,
    message: string,
    callbacks: {
      onMessage?: (chunk: { data: string; event?: string }) => void;
      onDone?: () => void;
      onError?: (error: Error) => void;
    }
  ): Promise<void> {
    await this.services.chat.streamChat(
      {
        text: message,
        userId: this.services.config.userAddress,
        userAddress: this.services.config.userAddress,
        sessionId
      },
      {
        onMessage: callbacks.onMessage || (() => {}),
        onDone: callbacks.onDone || (() => {}),
        onError: callbacks.onError ? (event: any) => callbacks.onError!(new Error(event.data)) : undefined
      }
    );
  }

  /**
   * Update session title
   *
   * @param sessionId - Session ID
   * @param title - New title
   */
  async updateTitle(sessionId: string, title: string): Promise<void> {
    await this.services.chat.updateSessionTitle(
      sessionId,
      this.services.config.userAddress,
      title
    );
  }

  /**
   * Delete chat session
   *
   * @param sessionId - Session ID
   */
  async delete(sessionId: string): Promise<void> {
    await this.services.chat.deleteSession(
      sessionId,
      this.services.config.userAddress
    );
  }
}

// ============================================================================
// AI Namespace
// ============================================================================

/**
 * AI Namespace - Unified AI Operations
 *
 * Consolidates embeddings, classification, and chat into one namespace.
 *
 * @example
 * ```typescript
 * // Generate embeddings
 * const vector = await pdw.ai.embed('Hello world');
 *
 * // Classify content
 * const category = await pdw.ai.classify('I love TypeScript');
 *
 * // Chat with memory context
 * const session = await pdw.ai.chat.createSession();
 * const response = await pdw.ai.chat.send(session.id, 'What do you know about me?');
 * ```
 */
export class AINamespace {
  private _chat: ChatSubNamespace;

  constructor(private services: ServiceContainer) {
    this._chat = new ChatSubNamespace(services);
  }

  // ==========================================================================
  // Chat Sub-Namespace
  // ==========================================================================

  /**
   * Chat operations with memory context
   */
  get chat(): ChatSubNamespace {
    return this._chat;
  }

  // ==========================================================================
  // Embedding Operations (from EmbeddingsNamespace)
  // ==========================================================================

  /**
   * Generate embedding for single text
   *
   * @param text - Text to embed
   * @param options - Embedding options
   * @returns Embedding vector (768 dimensions for Gemini)
   *
   * @example
   * ```typescript
   * const vector = await pdw.ai.embed('My favorite color is blue');
   * console.log(vector.length); // 768
   * ```
   */
  async embed(text: string, options?: EmbedOptions): Promise<number[]> {
    if (!this.services.embedding) {
      throw new Error('Embedding service not configured. Please provide geminiApiKey.');
    }
    const result = await this.services.embedding.embedText({ text });
    return result.vector;
  }

  /**
   * Generate embeddings for multiple texts (batch)
   *
   * @param texts - Array of texts
   * @returns Array of embedding vectors
   *
   * @example
   * ```typescript
   * const vectors = await pdw.ai.embedBatch(['Hello', 'World', 'TypeScript']);
   * console.log(vectors.length); // 3
   * ```
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.services.embedding) {
      throw new Error('Embedding service not configured.');
    }
    const result = await this.services.embedding.embedBatch(texts);
    return result.vectors;
  }

  /**
   * Calculate cosine similarity between two vectors
   *
   * @param vector1 - First vector
   * @param vector2 - Second vector
   * @returns Similarity score (0-1, higher is more similar)
   *
   * @example
   * ```typescript
   * const v1 = await pdw.ai.embed('cat');
   * const v2 = await pdw.ai.embed('dog');
   * const similarity = pdw.ai.similarity(v1, v2);
   * console.log(similarity); // ~0.85 (similar concepts)
   * ```
   */
  similarity(vector1: number[], vector2: number[]): number {
    if (!this.services.embedding) {
      throw new Error('Embedding service not configured.');
    }
    return this.services.embedding.calculateCosineSimilarity(vector1, vector2);
  }

  /**
   * Find most similar vectors from candidates
   *
   * @param queryVector - Query vector
   * @param candidateVectors - Candidate vectors to compare
   * @param k - Number of results (default: 5)
   * @returns Top k similar vectors with scores
   *
   * @example
   * ```typescript
   * const query = await pdw.ai.embed('programming');
   * const candidates = await pdw.ai.embedBatch(['TypeScript', 'cooking', 'Java']);
   * const similar = pdw.ai.findSimilar(query, candidates, 2);
   * // Returns indices 0 (TypeScript) and 2 (Java) as most similar
   * ```
   */
  findSimilar(
    queryVector: number[],
    candidateVectors: number[][],
    k: number = 5
  ): Array<{ index: number; score: number }> {
    if (!this.services.embedding) {
      throw new Error('Embedding service not configured.');
    }
    const results = this.services.embedding.findMostSimilar(queryVector, candidateVectors, k);
    return results.map(r => ({
      index: r.index,
      score: r.similarity
    }));
  }

  // ==========================================================================
  // Classification Operations (from ClassifyNamespace)
  // ==========================================================================

  /**
   * Classify content into category
   *
   * Uses AI to determine the most appropriate category.
   *
   * @param content - Text content to classify
   * @returns Category name (fact, preference, todo, note, general, etc.)
   *
   * @example
   * ```typescript
   * const category = await pdw.ai.classify('I prefer dark mode');
   * // Returns: 'preference'
   * ```
   */
  async classify(content: string): Promise<string> {
    if (!this.services.classifier) {
      throw new Error('Classifier service not configured. Please provide geminiApiKey.');
    }
    return await this.services.classifier.classifyContent(content);
  }

  /**
   * Determine if content should be saved as a memory
   *
   * Uses AI and pattern matching to decide if content is worth saving.
   * By default, only explicit commands like "remember that" trigger saves.
   *
   * @param content - Text content to analyze
   * @param options - Options for classification
   * @param options.explicitOnly - If true (default), only explicit memory commands trigger save
   * @returns true if should save, false otherwise
   *
   * @example
   * ```typescript
   * // Default: only explicit commands
   * const shouldSave = await pdw.ai.shouldSave('Remember that I love TypeScript');
   * // Returns: true
   *
   * // With explicitOnly=false, pattern matching is more aggressive
   * const shouldSave2 = await pdw.ai.shouldSave('I love TypeScript', { explicitOnly: false });
   * // Returns: true (matches "I love..." pattern)
   * ```
   */
  async shouldSave(content: string, options?: { explicitOnly?: boolean }): Promise<boolean> {
    if (!this.services.classifier) {
      throw new Error('Classifier service not configured. Please provide geminiApiKey.');
    }
    const result = await this.services.classifier.shouldSaveMemory(content, {
      explicitOnly: options?.explicitOnly ?? true // Default to explicit-only
    });
    return result.shouldSave;
  }

  /**
   * Extract memory content from explicit command
   *
   * Parses commands like "remember that X" and extracts X.
   *
   * @param message - User message to parse
   * @returns Extracted content or null if no command found
   *
   * @example
   * ```typescript
   * const content = pdw.ai.extractMemoryContent('Remember that my name is John');
   * // Returns: 'my name is John'
   *
   * const content2 = pdw.ai.extractMemoryContent('Hello there');
   * // Returns: null
   * ```
   */
  extractMemoryContent(message: string): string | null {
    const patterns = [
      /remember that\s+(.+)/i,
      /remember:?\s+(.+)/i,
      /don't forget that\s+(.+)/i,
      /don't forget:?\s+(.+)/i,
      /please remember\s+(.+)/i,
      /store (?:this )?(?:in|to) memory:?\s*(.+)/i,
      /save (?:this )?(?:in|to) memory:?\s*(.+)/i,
      /add (?:this )?to (?:my )?memory:?\s*(.+)/i,
      /keep in mind:?\s+(.+)/i,
      /note that\s+(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    return null;
  }

  /**
   * Extract multiple memories from a single message
   *
   * Splits a message containing multiple facts/memories into individual items.
   * Supports comma-separated, semicolon-separated, "and"-separated, and numbered lists.
   *
   * @param message - User message potentially containing multiple memories
   * @returns Array of extracted memory contents, or empty array if no pattern matched
   *
   * @example
   * ```typescript
   * // Comma-separated
   * pdw.ai.extractMultipleMemories('Remember that my name is John, I work at Google, and my birthday is Dec 25');
   * // Returns: ['my name is John', 'I work at Google', 'my birthday is Dec 25']
   *
   * // Semicolon-separated
   * pdw.ai.extractMultipleMemories('Note that: API key is abc123; server port is 3000; database is PostgreSQL');
   * // Returns: ['API key is abc123', 'server port is 3000', 'database is PostgreSQL']
   *
   * // Numbered list
   * pdw.ai.extractMultipleMemories('Remember: 1. My email is test@example 2. My phone is 123-456 3. I prefer dark mode');
   * // Returns: ['My email is test@example', 'My phone is 123-456', 'I prefer dark mode']
   *
   * // Single memory (fallback to extractMemoryContent)
   * pdw.ai.extractMultipleMemories('Remember that I like pizza');
   * // Returns: ['I like pizza']
   * ```
   */
  extractMultipleMemories(message: string): string[] {
    // First, extract the content after the memory keyword
    const content = this.extractMemoryContent(message);
    if (!content) {
      return [];
    }

    // Try numbered list pattern: "1. xxx 2. yyy 3. zzz"
    const numberedPattern = /\d+\.\s*([^0-9]+?)(?=\d+\.|$)/g;
    const numberedMatches = [...content.matchAll(numberedPattern)];
    if (numberedMatches.length > 1) {
      return numberedMatches
        .map(m => m[1].trim())
        .filter(s => s.length > 0);
    }

    // Try bullet list pattern: "- xxx - yyy" or "• xxx • yyy"
    const bulletPattern = /[-•]\s*([^-•]+)/g;
    const bulletMatches = [...content.matchAll(bulletPattern)];
    if (bulletMatches.length > 1) {
      return bulletMatches
        .map(m => m[1].trim())
        .filter(s => s.length > 0);
    }

    // Try semicolon-separated
    if (content.includes(';')) {
      const parts = content.split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      if (parts.length > 1) {
        return parts;
      }
    }

    // Try comma + "and" pattern: "xxx, yyy, and zzz" or "xxx, yyy and zzz"
    // Also handles simple comma-separated: "xxx, yyy, zzz"
    const commaAndPattern = /,\s*(?:and\s+)?|\s+and\s+/i;
    if (commaAndPattern.test(content)) {
      const parts = content.split(commaAndPattern)
        .map(s => s.trim())
        .filter(s => s.length > 0);
      if (parts.length > 1) {
        return parts;
      }
    }

    // Single memory - return as array with one item
    return [content];
  }

  /**
   * Check if message is a memory query (asking about stored memories)
   *
   * @param message - User message to check
   * @returns true if user is asking about their memories
   *
   * @example
   * ```typescript
   * pdw.ai.isMemoryQuery('What do you remember about me?'); // true
   * pdw.ai.isMemoryQuery('What is my name?'); // true
   * pdw.ai.isMemoryQuery('Hello'); // false
   * ```
   */
  isMemoryQuery(message: string): boolean {
    const queryPatterns = [
      /what do you (remember|know) about me/i,
      /what('s| is) my (name|email|birthday|job|work|address)/i,
      /do you (remember|know) my/i,
      /tell me what you (remember|know)/i,
      /what have i told you/i,
      /what memories do you have/i,
    ];
    return queryPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Get full classification result with details
   *
   * @param content - Text content to classify
   * @returns Full classification result with confidence and reasoning
   *
   * @example
   * ```typescript
   * const result = await pdw.ai.classifyFull('My birthday is January 15');
   * // Returns: { shouldSave: true, confidence: 0.95, category: 'personal_info', reasoning: '...' }
   * ```
   */
  async classifyFull(content: string): Promise<ClassificationResult> {
    if (!this.services.classifier) {
      throw new Error('Classifier service not configured. Please provide geminiApiKey.');
    }
    return await this.services.classifier.shouldSaveMemory(content);
  }

  /**
   * Analyze patterns in content
   *
   * Detects patterns like personal info, contact details, preferences, etc.
   *
   * @param content - Text content to analyze
   * @returns Pattern analysis with detected patterns and suggested category
   *
   * @example
   * ```typescript
   * const analysis = await pdw.ai.patterns('My email is user@example.com');
   * // Returns: { patterns: [{ type: 'contact', ... }], suggestedCategory: 'contact' }
   * ```
   */
  async patterns(content: string): Promise<PatternAnalysis> {
    if (!this.services.classifier) {
      throw new Error('Classifier service not configured. Please provide geminiApiKey.');
    }
    const result = await this.services.classifier.analyzePatterns(content);
    return {
      patterns: result.patterns.map((p: string) => ({
        type: p,
        confidence: 1.0,
        examples: []
      })),
      categories: result.categories || [],
      suggestedCategory: result.categories[0] || 'general'
    };
  }

  /**
   * Calculate importance score for content
   *
   * Uses AI to determine how important the content is (1-10 scale).
   *
   * @param content - Text content to score
   * @returns Importance score (1-10)
   *
   * @example
   * ```typescript
   * const importance = await pdw.ai.importance('Emergency contact: 911');
   * // Returns: 10
   * ```
   */
  async importance(content: string): Promise<number> {
    if (!this.services.classifier) {
      throw new Error('Classifier service not configured. Please provide geminiApiKey.');
    }
    const category = await this.services.classifier.classifyContent(content);
    const categoryImportance: Record<string, number> = {
      'emergency': 10,
      'contact': 9,
      'personal_info': 8,
      'career': 7,
      'preference': 6,
      'fact': 5,
      'note': 4,
      'general': 3
    };
    return categoryImportance[category] || 5;
  }
}
