/**
 * GeminiAIService - AI Integration via OpenRouter
 *
 * Provides AI-powered text analysis capabilities using OpenRouter API
 * for entity extraction, relationship identification, and content analysis.
 *
 * Supports any model available on OpenRouter (Google Gemini, OpenAI, Anthropic, etc.)
 */

export interface GeminiConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

export interface EntityExtractionRequest {
  content: string;
  context?: string;
  confidenceThreshold?: number;
}

export interface EntityExtractionResponse {
  entities: Array<{
    id: string;
    label: string;
    type: string;
    confidence: number;
    properties?: Record<string, any>;
  }>;
  relationships: Array<{
    source: string;
    target: string;
    label: string;
    confidence: number;
    type?: string;
  }>;
  processingTimeMs: number;
}

/**
 * AI service for advanced text analysis and knowledge extraction
 * Uses OpenRouter API for maximum flexibility and model choice
 */
export class GeminiAIService {
  private readonly apiKey: string;
  private readonly config: Required<GeminiConfig>;

  constructor(config: GeminiConfig) {
    // Resolve API key: prefer OPENROUTER_API_KEY, fallback to provided apiKey
    this.apiKey = process.env.OPENROUTER_API_KEY || config.apiKey;

    if (!this.apiKey) {
      throw new Error(
        'API key is required. Set OPENROUTER_API_KEY environment variable or provide apiKey in config.'
      );
    }

    this.config = {
      model: config.model || process.env.AI_CHAT_MODEL || 'google/gemini-2.5-flash',
      temperature: config.temperature || 0.1,
      maxTokens: config.maxTokens || 4096,
      timeout: config.timeout || 30000,
      apiKey: this.apiKey
    };

    console.log(`✅ GeminiAIService initialized with OpenRouter (${this.config.model})`);
  }

  /**
   * Call OpenRouter Chat Completions API
   */
  private async callOpenRouter(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/personal-data-wallet',
          'X-Title': 'Personal Data Wallet SDK'
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'user', content: prompt }
          ],
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} - ${errorData}`);
      }

      const data = await response.json();

      if (!data.choices || !data.choices[0] || !data.choices[0].message) {
        throw new Error('Invalid response from OpenRouter API');
      }

      return data.choices[0].message.content || '';
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OpenRouter request timed out after ${this.config.timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Extract entities and relationships from text using AI
   */
  async extractEntitiesAndRelationships(request: EntityExtractionRequest): Promise<EntityExtractionResponse> {
    const startTime = Date.now();

    try {
      // Validate input: return empty result for empty/whitespace-only content
      const trimmedContent = request.content?.trim();
      if (!trimmedContent || trimmedContent.length === 0) {
        return {
          entities: [],
          relationships: [],
          processingTimeMs: Date.now() - startTime
        };
      }

      const prompt = this.buildExtractionPrompt(request.content, request.context);
      const text = await this.callOpenRouter(prompt);

      const parsed = this.parseExtractionResponse(text);
      const processingTimeMs = Date.now() - startTime;

      return {
        entities: parsed.entities,
        relationships: parsed.relationships,
        processingTimeMs
      };

    } catch (error) {
      console.error('AI extraction failed:', error);

      // Return empty result with processing time on error
      return {
        entities: [],
        relationships: [],
        processingTimeMs: Date.now() - startTime
      };
    }
  }

  /**
   * Extract entities and relationships from multiple texts in batch
   */
  async extractBatch(requests: EntityExtractionRequest[]): Promise<EntityExtractionResponse[]> {
    const results: EntityExtractionResponse[] = [];

    // Process in batches to avoid rate limiting
    const batchSize = 3;
    for (let i = 0; i < requests.length; i += batchSize) {
      const batch = requests.slice(i, i + batchSize);
      const batchPromises = batch.map(request => this.extractEntitiesAndRelationships(request));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Small delay between batches to respect rate limits
      if (i + batchSize < requests.length) {
        await this.delay(500);
      }
    }

    return results;
  }

  /**
   * Analyze text content for categorization and sentiment
   */
  async analyzeContent(content: string): Promise<{
    categories: string[];
    sentiment: 'positive' | 'negative' | 'neutral';
    topics: string[];
    confidence: number;
  }> {
    try {
      const prompt = `
Analyze the following text and provide a JSON response with:
- "categories": array of relevant categories (max 3)
- "sentiment": "positive", "negative", or "neutral"
- "topics": array of main topics/themes (max 5)
- "confidence": overall analysis confidence (0.0-1.0)

TEXT: ${content}

JSON:`;

      const text = await this.callOpenRouter(prompt);
      return this.parseAnalysisResponse(text);

    } catch (error) {
      console.error('Content analysis failed:', error);
      return {
        categories: [],
        sentiment: 'neutral',
        topics: [],
        confidence: 0
      };
    }
  }

  // ==================== PRIVATE METHODS ====================

  private buildExtractionPrompt(content: string, context?: string): string {
    const contextSection = context ? `\nCONTEXT: ${context}\n` : '';

    return `
Extract meaningful entities and relationships from the following text. Focus on:
- People (names, roles, professions)
- Organizations (companies, institutions, groups)
- Locations (cities, countries, places)
- Concepts (technologies, ideas, skills)
- Events (meetings, projects, activities)
- Objects (products, tools, resources)

Return a valid JSON response with "entities" and "relationships" arrays.

For entities:
- "id": unique identifier using snake_case (e.g., "john_doe", "machine_learning")
- "label": human-readable name (e.g., "John Doe", "Machine Learning")
- "type": entity category (person, organization, location, concept, event, object)
- "confidence": confidence score 0.0-1.0
- "properties": optional additional attributes

For relationships:
- "source": source entity id
- "target": target entity id
- "label": relationship description (e.g., "works_at", "located_in", "uses")
- "confidence": confidence score 0.0-1.0
- "type": optional relationship category

Only include entities with confidence >= 0.6 and clear, meaningful relationships.
${contextSection}
TEXT: ${content}

JSON:`;
  }

  private parseExtractionResponse(response: string): { entities: any[]; relationships: any[] } {
    try {
      // Clean up the response text (remove markdown formatting if present)
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/```\s*/, '').replace(/```\s*$/, '');
      }

      const parsed = JSON.parse(cleanResponse);

      if (!parsed.entities || !Array.isArray(parsed.entities)) {
        throw new Error('Invalid entities format');
      }
      if (!parsed.relationships || !Array.isArray(parsed.relationships)) {
        throw new Error('Invalid relationships format');
      }

      // Validate and sanitize entities
      const entities = parsed.entities
        .filter((e: any) => e.id && e.label && e.type)
        .map((e: any) => ({
          id: this.sanitizeId(e.id),
          label: e.label.trim(),
          type: e.type.toLowerCase(),
          confidence: Math.max(0, Math.min(1, e.confidence || 0.7)),
          properties: e.properties || {}
        }));

      // Create entity ID map for relationship validation
      const entityIds = new Set(entities.map((e: any) => e.id));

      // Validate and sanitize relationships
      const relationships = parsed.relationships
        .filter((r: any) => r.source && r.target && r.label)
        .filter((r: any) => entityIds.has(this.sanitizeId(r.source)) && entityIds.has(this.sanitizeId(r.target)))
        .map((r: any) => ({
          source: this.sanitizeId(r.source),
          target: this.sanitizeId(r.target),
          label: r.label.trim(),
          confidence: Math.max(0, Math.min(1, r.confidence || 0.7)),
          type: r.type || 'general'
        }));

      return { entities, relationships };

    } catch (error) {
      // Only log detailed errors in development mode
      if (process.env.NODE_ENV === 'development') {
        console.error('Failed to parse AI response:', error);
        console.error('Raw response:', response);
      }
      return { entities: [], relationships: [] };
    }
  }

  private parseAnalysisResponse(response: string): any {
    try {
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/```json\s*/, '').replace(/```\s*$/, '');
      }

      const parsed = JSON.parse(cleanResponse);

      return {
        categories: parsed.categories || [],
        sentiment: parsed.sentiment || 'neutral',
        topics: parsed.topics || [],
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5))
      };

    } catch (error) {
      console.error('Failed to parse analysis response:', error);
      return {
        categories: [],
        sentiment: 'neutral',
        topics: [],
        confidence: 0
      };
    }
  }

  private sanitizeId(id: string): string {
    return id
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if the service is properly configured and can make API calls
   */
  async testConnection(): Promise<boolean> {
    try {
      const text = await this.callOpenRouter('Test connection. Respond with only "OK".');
      return text.includes('OK');
    } catch {
      return false;
    }
  }

  /**
   * Get service configuration (without sensitive data)
   */
  getConfig(): Omit<Required<GeminiConfig>, 'apiKey'> & { apiKeyConfigured: boolean } {
    return {
      model: this.config.model,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      timeout: this.config.timeout,
      apiKeyConfigured: !!this.apiKey
    };
  }
}

export default GeminiAIService;
