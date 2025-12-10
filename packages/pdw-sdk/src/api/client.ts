/**
 * API Client for Personal Data Wallet Backend
 * 
 * Handles HTTP communication with the NestJS backend API
 */

import type { 
  APIResponse, 
  MemoryCreateOptions, 
  MemorySearchOptions, 
  MemorySearchResult,
  MemoryContext,
  MemoryContextOptions,
  ChatOptions,
  ChatSession,
  CreateSessionOptions,
  MemoryStatsResponse
} from '../types';
import type { BatchStats } from '../core';

export class PDWApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  get baseURL() { return this.baseUrl; }
  get defaultHeaders() { return this.headers; }

  constructor(apiUrl: string) {
    this.baseUrl = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
    this.headers = {
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    endpoint: string, 
    options: RequestInit = {}
  ): Promise<APIResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.headers,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  // ==================== MEMORY API ====================

  async createMemory(options: MemoryCreateOptions): Promise<APIResponse<{ memoryId: string }>> {
    return this.request('/memories', {
      method: 'POST',
      body: JSON.stringify({
        content: options.content,
        category: options.category,
        userAddress: options.userAddress,
        topic: options.topic,
        importance: options.importance,
        customMetadata: options.customMetadata,
      }),
    });
  }

  async getUserMemories(userAddress: string): Promise<APIResponse<{ memories: MemorySearchResult[] }>> {
    return this.request(`/memories?user=${encodeURIComponent(userAddress)}`);
  }

  async searchMemories(options: MemorySearchOptions): Promise<APIResponse<{ results: MemorySearchResult[] }>> {
    return this.request('/memories/search', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async getMemoryContext(options: MemoryContextOptions): Promise<APIResponse<MemoryContext>> {
    return this.request('/memories/context', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async getMemoryStats(userAddress: string): Promise<APIResponse<MemoryStatsResponse>> {
    return this.request(`/memories/stats?userAddress=${encodeURIComponent(userAddress)}`);
  }

  async deleteMemory(memoryId: string, userAddress: string): Promise<APIResponse<void>> {
    return this.request(`/memories/${memoryId}`, {
      method: 'DELETE',
      body: JSON.stringify({ userAddress }),
    });
  }

  async getBatchStats(): Promise<APIResponse<BatchStats>> {
    return this.request('/memories/batch-stats');
  }

  // ==================== CHAT API ====================

  async getChatSessions(userAddress: string): Promise<APIResponse<{ sessions: ChatSession[] }>> {
    return this.request(`/chat/sessions?userAddress=${encodeURIComponent(userAddress)}`);
  }

  async getChatSession(sessionId: string, userAddress: string): Promise<APIResponse<ChatSession>> {
    return this.request(`/chat/sessions/${sessionId}?userAddress=${encodeURIComponent(userAddress)}`);
  }

  async createChatSession(options: CreateSessionOptions): Promise<APIResponse<ChatSession>> {
    return this.request('/chat/sessions', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  }

  async deleteChatSession(sessionId: string, userAddress: string): Promise<APIResponse<void>> {
    return this.request(`/chat/sessions/${sessionId}`, {
      method: 'DELETE',
      body: JSON.stringify({ userAddress }),
    });
  }

  async sendChatMessage(options: ChatOptions): Promise<APIResponse<any>> {
    return this.request('/chat', {
      method: 'POST',
      body: JSON.stringify({
        text: options.text,
        userId: options.userId,
        sessionId: options.sessionId,
        model: options.model,
        userAddress: options.userAddress,
        memoryContext: options.memoryContext,
      }),
    });
  }

  async updateChatSessionTitle(sessionId: string, userAddress: string, title: string): Promise<APIResponse<void>> {
    return this.request(`/chat/sessions/${sessionId}/title`, {
      method: 'PUT',
      body: JSON.stringify({ userAddress, title }),
    });
  }

  async addMessageToSession(sessionId: string, content: string, type: string, userAddress: string): Promise<APIResponse<void>> {
    return this.request(`/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, type, userAddress }),
    });
  }

  async saveChatSummary(sessionId: string, summary: string, userAddress: string): Promise<APIResponse<void>> {
    return this.request('/chat/summary', {
      method: 'POST',
      body: JSON.stringify({ sessionId, summary, userAddress }),
    });
  }

  /**
   * Create EventSource for streaming chat responses
   */
  createChatStream(options: ChatOptions): EventSource {
    const params = new URLSearchParams({
      text: options.text,
      userId: options.userId,
      ...(options.sessionId && { sessionId: options.sessionId }),
      ...(options.model && { model: options.model }),
      ...(options.userAddress && { userAddress: options.userAddress }),
      ...(options.memoryContext && { memoryContext: options.memoryContext }),
    });

    return new EventSource(`${this.baseUrl}/chat/stream?${params.toString()}`);
  }
}