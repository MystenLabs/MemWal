/**
 * Chat Namespace - AI Chat with Memory Context
 *
 * Pure delegation to ChatService for memory-aware conversations.
 * Automatically retrieves relevant memories as context for AI responses.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

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
 * Chat Namespace
 *
 * Handles AI chat operations with memory context
 */
export class ChatNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Create a new chat session
   *
   * Delegates to: ChatService.createSession()
   *
   * @param options - Session options
   * @returns Created session
   */
  async createSession(options?: { title?: string; model?: string }): Promise<ChatSession> {
    const result = await this.services.chat.createSession({
      userAddress: this.services.config.userAddress,
      modelName: options?.model || 'gemini-2.5-flash-lite',
      title: options?.title || 'New Chat'
    });

    // ChatService returns ChatSessionResponse, adapt to ChatSession
    return result.session as any as ChatSession;
  }

  /**
   * Get chat session
   *
   * Delegates to: ChatService.getSession()
   *
   * @param sessionId - Session ID
   * @returns Session with messages
   */
  async getSession(sessionId: string): Promise<ChatSession> {
    const result = await this.services.chat.getSession(
      sessionId,
      this.services.config.userAddress
    );

    return result.session as any as ChatSession;
  }

  /**
   * Get all user sessions
   *
   * Delegates to: ChatService.getSessions()
   *
   * @returns Array of sessions
   */
  async getSessions(): Promise<ChatSession[]> {
    const result = await this.services.chat.getSessions(
      this.services.config.userAddress
    );

    return result.sessions as any as ChatSession[];
  }

  /**
   * Send message (non-streaming)
   *
   * Delegates to: ChatService.sendMessage()
   *
   * @param sessionId - Session ID
   * @param message - Message text
   * @returns AI response
   */
  async send(sessionId: string, message: string): Promise<ChatMessage> {
    const result = await this.services.chat.sendMessage({
      text: message,
      userId: this.services.config.userAddress,
      userAddress: this.services.config.userAddress,
      sessionId
    });

    return {
      role: 'assistant' as const,  // ChatService returns response message
      content: result.content || '',
      timestamp: Date.now()
    };
  }

  /**
   * Stream chat response
   *
   * Delegates to: ChatService.streamChat()
   *
   * @param sessionId - Session ID
   * @param message - Message text
   * @param callbacks - Streaming callbacks
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
   * Delegates to: ChatService.updateSessionTitle()
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
   * Delegates to: ChatService.deleteSession()
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
