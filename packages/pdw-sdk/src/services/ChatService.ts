import { PDWApiClient } from '../api/client';
import {
  ChatMessage,
  ChatSession,
  ChatMessageRequest,
  ChatMessageResponse,
  CreateChatSessionRequest,
  ChatSessionResponse,
  ChatSessionsResponse,
  StreamChatEvent,
  UpdateSessionTitleRequest,
  AddMessageRequest,
  SaveSummaryRequest,
  ChatStreamOptions,
} from '../types';

/**
 * ChatService handles all chat-related operations including session management,
 * message sending, and streaming responses with memory context integration.
 */
export class ChatService {
  constructor(private apiClient: PDWApiClient) {}

  /**
   * Get all chat sessions for a user
   */
  async getSessions(userAddress: string): Promise<ChatSessionsResponse> {
    try {
      const response = await this.apiClient.getChatSessions(userAddress);
      return {
        success: response.success,
        sessions: response.data?.sessions || [],
        message: response.message
      };
    } catch (error) {
      console.error('Failed to get chat sessions:', error);
      throw new Error(`Failed to get chat sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get a specific chat session with messages
   */
  async getSession(sessionId: string, userAddress: string): Promise<ChatSessionResponse> {
    try {
      const response = await this.apiClient.getChatSession(sessionId, userAddress);
      return {
        success: response.success,
        session: response.data!,
        message: response.message
      };
    } catch (error) {
      console.error(`Failed to get session ${sessionId}:`, error);
      throw new Error(`Failed to get session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create a new chat session
   */
  async createSession(request: CreateChatSessionRequest): Promise<ChatSessionResponse> {
    try {
      const response = await this.apiClient.createChatSession(request);
      return {
        success: response.success,
        session: response.data!,
        message: response.message
      };
    } catch (error) {
      console.error('Failed to create chat session:', error);
      throw new Error(`Failed to create chat session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete a chat session
   */
  async deleteSession(sessionId: string, userAddress: string): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.apiClient.deleteChatSession(sessionId, userAddress);
      return {
        success: response.success,
        message: response.message
      };
    } catch (error) {
      console.error(`Failed to delete session ${sessionId}:`, error);
      throw new Error(`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Update the title of a chat session
   */
  async updateSessionTitle(
    sessionId: string, 
    userAddress: string, 
    title: string
  ): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.apiClient.updateChatSessionTitle(sessionId, userAddress, title);
      return {
        success: response.success,
        message: response.message
      };
    } catch (error) {
      console.error(`Failed to update session title for ${sessionId}:`, error);
      throw new Error(`Failed to update session title: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Add a message to a chat session
   */
  async addMessage(sessionId: string, request: AddMessageRequest): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.apiClient.addMessageToSession(sessionId, request.content, request.type, request.userAddress);
      return {
        success: response.success,
        message: response.message
      };
    } catch (error) {
      console.error(`Failed to add message to session ${sessionId}:`, error);
      throw new Error(`Failed to add message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save a summary for a chat session
   */
  async saveSummary(request: SaveSummaryRequest): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.apiClient.saveChatSummary(request.sessionId, request.summary, request.userAddress);
      return {
        success: response.success,
        message: response.message
      };
    } catch (error) {
      console.error('Failed to save chat summary:', error);
      throw new Error(`Failed to save summary: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Send a non-streaming chat message
   */
  async sendMessage(request: ChatMessageRequest): Promise<ChatMessageResponse> {
    try {
      const response = await this.apiClient.sendChatMessage({
        text: request.text,
        userId: request.userId,
        sessionId: request.sessionId,
        model: request.model,
        userAddress: request.userAddress,
        memoryContext: request.memoryContext
      });
      return response.data!;
    } catch (error) {
      console.error('Failed to send chat message:', error);
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stream chat responses using Server-Sent Events
   * Returns a promise that resolves when the stream completes
   */
  async streamChat(request: ChatMessageRequest, options: ChatStreamOptions = {}): Promise<void> {
    const { 
      onMessage, 
      onThinking, 
      onMemory, 
      onError, 
      onDone, 
      abortController 
    } = options;

    return new Promise((resolve, reject) => {
      try {
        // Since EventSource only supports GET, we'll use fetch for streaming POST
        this.streamChatWithFetch(request, options)
          .then(resolve)
          .catch(reject);
      } catch (error) {
        console.error('Failed to initialize chat stream:', error);
        reject(new Error(`Failed to stream chat: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  /**
   * Stream chat using fetch API with streaming response
   */
  private async streamChatWithFetch(request: ChatMessageRequest, options: ChatStreamOptions = {}): Promise<void> {
    const { 
      onMessage, 
      onThinking, 
      onMemory, 
      onError, 
      onDone, 
      abortController 
    } = options;

    try {
      const response = await fetch(`${this.apiClient.baseURL}/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...this.apiClient.defaultHeaders,
        },
        body: JSON.stringify(request),
        signal: abortController?.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            onDone?.();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const eventData = line.slice(6).trim();
              
              if (eventData === '') continue; // Empty data line
              
              try {
                const event: StreamChatEvent = JSON.parse(eventData);
                
                switch (event.type) {
                  case 'message':
                    onMessage?.(event);
                    break;
                  case 'thinking':
                    onThinking?.(event);
                    break;
                  case 'memory':
                    onMemory?.(event);
                    break;
                  case 'error':
                    onError?.(event);
                    break;
                  case 'done':
                    onDone?.();
                    return;
                  default:
                    console.warn('Unknown event type:', event.type);
                }
              } catch (parseError) {
                console.error('Failed to parse SSE event:', parseError, 'Data:', eventData);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error('Streaming chat error:', error);
      onError?.({
        type: 'error',
        data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Convenient method to stream chat with simple callback
   */
  async streamChatSimple(
    request: ChatMessageRequest,
    onMessage: (content: string) => void,
    onError?: (error: string) => void,
    onDone?: () => void
  ): Promise<void> {
    return this.streamChat(request, {
      onMessage: (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.content) {
            onMessage(data.content);
          }
        } catch (error) {
          console.error('Failed to parse message event:', error);
        }
      },
      onError: (event) => {
        try {
          const data = JSON.parse(event.data);
          onError?.(data.message || 'Unknown error');
        } catch (error) {
          onError?.(event.data);
        }
      },
      onDone,
    });
  }

  /**
   * Create a convenient chat interface with session management
   */
  async createChatInterface(userAddress: string, modelName: string = process.env.AI_CHAT_MODEL || 'google/gemini-2.5-flash') {
    const sessionResponse = await this.createSession({
      userAddress,
      modelName,
      title: 'New Chat',
    });

    const sessionId = sessionResponse.session.id;

    return {
      sessionId,
      session: sessionResponse.session,
      
      sendMessage: async (text: string) => {
        return this.sendMessage({
          text,
          userId: userAddress,
          sessionId,
          userAddress,
        });
      },
      
      streamMessage: async (text: string, options: ChatStreamOptions = {}) => {
        return this.streamChat({
          text,
          userId: userAddress,
          sessionId,
          userAddress,
        }, options);
      },
      
      updateTitle: async (title: string) => {
        return this.updateSessionTitle(sessionId, userAddress, title);
      },
      
      addMessage: async (content: string, type: 'user' | 'assistant' | 'system' = 'user') => {
        return this.addMessage(sessionId, {
          content,
          type,
          userAddress,
        });
      },
      
      delete: async () => {
        return this.deleteSession(sessionId, userAddress);
      },
    };
  }
}