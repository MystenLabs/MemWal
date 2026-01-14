/**
 * GeminiAIService - AI Integration via OpenRouter SDK
 *
 * Provides AI-powered text analysis capabilities using OpenRouter SDK
 * for entity extraction, relationship identification, and content analysis.
 *
 * Supports any model available on OpenRouter (Google Gemini, OpenAI, Anthropic, etc.)
 *
 * Refactored to use official @openrouter/sdk instead of raw fetch calls.
 */

import { OpenRouter } from '@openrouter/sdk';

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
 * Uses OpenRouter SDK for maximum flexibility and model choice
 */
export class GeminiAIService {
  private readonly apiKey: string;
  private readonly config: Required<GeminiConfig>;
  private readonly openRouterClient: OpenRouter;

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

    // Initialize OpenRouter SDK client
    this.openRouterClient = new OpenRouter({
      apiKey: this.apiKey
    });

    console.log(`✅ GeminiAIService initialized with OpenRouter SDK (${this.config.model})`);
  }

  /**
   * Call OpenRouter Chat Completions API using SDK
   */
  private async callOpenRouter(prompt: string): Promise<string> {
    try {
      const result = await this.openRouterClient.chat.send({
        model: this.config.model,
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        stream: false
      });

      if (!result.choices || !result.choices[0] || !result.choices[0].message) {
        throw new Error('Invalid response from OpenRouter API');
      }

      // Handle content which can be string or array
      const content = result.choices[0].message.content;
      if (typeof content === 'string') {
        return content;
      }
      if (Array.isArray(content)) {
        // Extract text from content items
        return content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text || '')
          .join('');
      }
      return '';
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`OpenRouter API error: ${error.message}`);
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
You are a knowledge graph extraction system for a Personal Data Wallet application. Your task is to extract meaningful entities and relationships from personal memories, notes, and user statements.

## CRITICAL RULE: User Entity
ALWAYS include a "user" entity to represent the person who wrote this memory:
{
  "id": "user",
  "label": "User",
  "type": "person",
  "confidence": 1.0
}
This "user" entity should be the source or target of relationships describing personal preferences, attributes, or experiences.

## Entity Types (Comprehensive List)

### People & Social
- **person**: Individual people, including the user themselves
  - Examples: "user", "john_doe", "my_mother", "boss"
  - Properties: name, role, relationship_to_user

### Organizations & Groups
- **organization**: Companies, institutions, teams, communities
  - Examples: "google", "harvard_university", "local_gym"
  - Properties: industry, size, location

### Locations & Places
- **location**: Geographic places, addresses, venues
  - Examples: "ho_chi_minh_city", "vietnam", "my_office", "central_park"
  - Properties: type (city/country/venue), coordinates

### Food & Dining
- **food**: Foods, dishes, cuisines, beverages, ingredients
  - Examples: "spaghetti", "vietnamese_cuisine", "coffee", "chocolate"
  - Properties: cuisine_type, meal_type, dietary_info
- **restaurant**: Eating establishments
  - Examples: "starbucks", "local_pho_shop"
  - Properties: cuisine, price_range

### Preferences & Interests
- **preference**: General likes, dislikes, favorites
  - Examples: "blue_color", "morning_routine", "minimalist_style"
  - Properties: sentiment (positive/negative/neutral), intensity (1-10)
- **hobby**: Recreational activities, pastimes
  - Examples: "playing_guitar", "photography", "hiking", "gaming"
  - Properties: frequency, skill_level
- **interest**: Topics of curiosity or passion
  - Examples: "artificial_intelligence", "history", "cooking"
  - Properties: depth (casual/moderate/deep)

### Skills & Abilities
- **skill**: Technical or soft skills, expertise areas
  - Examples: "python_programming", "public_speaking", "cooking"
  - Properties: proficiency (beginner/intermediate/expert)
- **language**: Languages known or being learned
  - Examples: "english", "vietnamese", "japanese"
  - Properties: proficiency, native (true/false)

### Objects & Possessions
- **object**: Physical items, products, tools
  - Examples: "macbook_pro", "my_car", "guitar"
  - Properties: brand, model, acquisition_date
- **digital_product**: Software, apps, digital services
  - Examples: "spotify", "notion", "chatgpt"
  - Properties: category, usage_frequency

### Time & Events
- **event**: Occasions, milestones, meetings
  - Examples: "birthday_2024", "job_interview", "vacation_trip"
  - Properties: date, duration, importance
- **routine**: Regular activities or habits
  - Examples: "morning_workout", "weekly_meeting", "daily_meditation"
  - Properties: frequency, time_of_day

### Abstract & Conceptual
- **concept**: Ideas, topics, abstract things
  - Examples: "work_life_balance", "productivity", "happiness"
- **goal**: Objectives, aspirations, plans
  - Examples: "learn_japanese", "run_marathon", "save_money"
  - Properties: deadline, priority, status
- **emotion**: Feelings, moods, emotional states
  - Examples: "happiness", "stress", "excitement"
  - Properties: intensity, trigger

### Health & Wellness
- **health_condition**: Medical conditions, allergies
  - Examples: "lactose_intolerance", "migraine", "allergy_to_peanuts"
- **medication**: Medicines, supplements
  - Examples: "vitamin_d", "aspirin"
- **exercise**: Physical activities for health
  - Examples: "running", "yoga", "weight_training"

### Media & Entertainment
- **music**: Songs, artists, genres, albums
  - Examples: "jazz_music", "beatles", "classical_piano"
- **movie**: Films, TV shows, documentaries
  - Examples: "inception", "game_of_thrones"
- **book**: Books, authors, genres
  - Examples: "atomic_habits", "fiction_genre"
- **game**: Video games, board games
  - Examples: "chess", "minecraft"

## Relationship Types (Comprehensive List)

### Preference Relationships (source: usually "user")
- **loves**: Strong positive preference (intensity 9-10)
- **likes**: Moderate positive preference (intensity 6-8)
- **enjoys**: Positive experience with something
- **prefers**: Comparative preference
- **favorite**: Top choice in a category
- **interested_in**: Curiosity or engagement
- **dislikes**: Moderate negative preference
- **hates**: Strong negative preference (intensity 9-10)
- **avoids**: Intentionally stays away from
- **allergic_to**: Medical/physical aversion

### Affiliation Relationships
- **works_at**: Employment relationship
- **studies_at**: Educational institution
- **member_of**: Group membership
- **belongs_to**: General affiliation
- **founded**: Created an organization
- **leads**: Leadership role

### Location Relationships
- **lives_in**: Current residence
- **from**: Origin/hometown
- **located_in**: Physical location
- **visited**: Past travel
- **wants_to_visit**: Travel aspiration

### Social Relationships
- **knows**: Acquaintance
- **friends_with**: Friendship
- **family_of**: Family relationship (specify: parent, sibling, child, spouse)
- **works_with**: Professional relationship
- **mentored_by**: Learning relationship

### Skill & Knowledge Relationships
- **has_skill**: Possesses ability
- **expert_in**: High proficiency
- **learning**: Currently acquiring
- **wants_to_learn**: Aspiration to learn
- **teaches**: Instructing others
- **certified_in**: Formal qualification

### Possession & Usage
- **owns**: Ownership
- **uses**: Regular usage
- **wants**: Desire to acquire
- **recommends**: Positive endorsement

### Temporal Relationships
- **started_on**: Beginning date
- **ended_on**: Ending date
- **scheduled_for**: Future event
- **happens_during**: Temporal context

### Causal & Descriptive
- **causes**: Causal relationship
- **related_to**: General association
- **part_of**: Component relationship
- **similar_to**: Similarity
- **opposite_of**: Contrast

## Output Format

Return ONLY valid JSON with this structure:
{
  "entities": [
    {
      "id": "snake_case_identifier",
      "label": "Human Readable Name",
      "type": "entity_type_from_list_above",
      "confidence": 0.0-1.0,
      "properties": { "optional": "attributes" }
    }
  ],
  "relationships": [
    {
      "source": "source_entity_id",
      "target": "target_entity_id",
      "label": "relationship_type_from_list_above",
      "confidence": 0.0-1.0,
      "type": "optional_category"
    }
  ]
}

## Examples

### Example 1: Food Preference
Input: "i love spaghetti"
Output:
{
  "entities": [
    {"id": "user", "label": "User", "type": "person", "confidence": 1.0},
    {"id": "spaghetti", "label": "Spaghetti", "type": "food", "confidence": 0.95, "properties": {"cuisine": "italian", "meal_type": "main_course"}}
  ],
  "relationships": [
    {"source": "user", "target": "spaghetti", "label": "loves", "confidence": 0.95, "type": "preference"}
  ]
}

### Example 2: Multiple Preferences
Input: "i like hamburgers but hate vegetables"
Output:
{
  "entities": [
    {"id": "user", "label": "User", "type": "person", "confidence": 1.0},
    {"id": "hamburgers", "label": "Hamburgers", "type": "food", "confidence": 0.95},
    {"id": "vegetables", "label": "Vegetables", "type": "food", "confidence": 0.95}
  ],
  "relationships": [
    {"source": "user", "target": "hamburgers", "label": "likes", "confidence": 0.9, "type": "preference"},
    {"source": "user", "target": "vegetables", "label": "dislikes", "confidence": 0.9, "type": "preference"}
  ]
}

### Example 3: Work Information
Input: "i work at Google as a software engineer in Mountain View"
Output:
{
  "entities": [
    {"id": "user", "label": "User", "type": "person", "confidence": 1.0, "properties": {"role": "software_engineer"}},
    {"id": "google", "label": "Google", "type": "organization", "confidence": 0.98, "properties": {"industry": "technology"}},
    {"id": "software_engineer", "label": "Software Engineer", "type": "skill", "confidence": 0.9},
    {"id": "mountain_view", "label": "Mountain View", "type": "location", "confidence": 0.95, "properties": {"type": "city"}}
  ],
  "relationships": [
    {"source": "user", "target": "google", "label": "works_at", "confidence": 0.98, "type": "affiliation"},
    {"source": "user", "target": "software_engineer", "label": "has_skill", "confidence": 0.9, "type": "skill"},
    {"source": "google", "target": "mountain_view", "label": "located_in", "confidence": 0.85, "type": "location"}
  ]
}

### Example 4: Personal Life
Input: "my name is Aaron and I live in Ho Chi Minh City with my wife"
Output:
{
  "entities": [
    {"id": "user", "label": "Aaron", "type": "person", "confidence": 1.0, "properties": {"name": "Aaron"}},
    {"id": "ho_chi_minh_city", "label": "Ho Chi Minh City", "type": "location", "confidence": 0.98, "properties": {"type": "city", "country": "Vietnam"}},
    {"id": "wife", "label": "Wife", "type": "person", "confidence": 0.9, "properties": {"relationship": "spouse"}}
  ],
  "relationships": [
    {"source": "user", "target": "ho_chi_minh_city", "label": "lives_in", "confidence": 0.98, "type": "location"},
    {"source": "user", "target": "wife", "label": "family_of", "confidence": 0.95, "type": "social", "properties": {"relationship_type": "spouse"}}
  ]
}

### Example 5: Hobbies and Interests
Input: "i enjoy playing guitar and listening to jazz music on weekends"
Output:
{
  "entities": [
    {"id": "user", "label": "User", "type": "person", "confidence": 1.0},
    {"id": "playing_guitar", "label": "Playing Guitar", "type": "hobby", "confidence": 0.95},
    {"id": "guitar", "label": "Guitar", "type": "object", "confidence": 0.9, "properties": {"category": "musical_instrument"}},
    {"id": "jazz_music", "label": "Jazz Music", "type": "music", "confidence": 0.95, "properties": {"genre": "jazz"}},
    {"id": "weekends", "label": "Weekends", "type": "routine", "confidence": 0.8, "properties": {"frequency": "weekly"}}
  ],
  "relationships": [
    {"source": "user", "target": "playing_guitar", "label": "enjoys", "confidence": 0.95, "type": "hobby"},
    {"source": "playing_guitar", "target": "guitar", "label": "uses", "confidence": 0.9, "type": "activity"},
    {"source": "user", "target": "jazz_music", "label": "enjoys", "confidence": 0.9, "type": "preference"},
    {"source": "playing_guitar", "target": "weekends", "label": "happens_during", "confidence": 0.8, "type": "temporal"}
  ]
}

## Guidelines

1. **Always include "user" entity** for personal statements (first-person: "I", "my", "me")
2. **Extract implicit information**: "i'm a doctor" implies medical skill
3. **Handle negations properly**: "don't like" = dislikes relationship
4. **Capture intensity**: "love" vs "like" vs "enjoy" = different confidence/intensity
5. **Include relevant properties**: cuisine type for food, location type for places
6. **Create bidirectional relationships when applicable**: if A works_at B, B employs A
7. **Minimum confidence threshold**: 0.5 for entities, 0.5 for relationships
8. **Be comprehensive**: Extract ALL meaningful entities, even from short texts
9. **Handle multilingual content**: Vietnamese, English, etc.
10. **Infer entity types from context**: "spaghetti" = food, "Python" = skill/language based on context
${contextSection}
## TEXT TO ANALYZE:
${content}

## JSON OUTPUT:`;
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
   * Extract rich metadata from content for memory creation
   * Returns importance (1-10), topic, and summary
   */
  async extractRichMetadata(content: string, categoryHint?: string): Promise<{
    importance: number;
    topic: string;
    summary: string;
    category: string;
  }> {
    try {
      const prompt = `
Analyze the following text and extract rich metadata in JSON format:
- "importance": relevance/importance score from 1-10 (1=trivial, 10=critical)
- "topic": concise topic/title (max 100 chars)
- "summary": brief summary (max 200 chars)
- "category": best-fit category (personal, work, education, health, finance, travel, family, hobbies, goals, ideas)

Consider:
- Importance: How valuable is this information for future recall?
- Topic: What's the main subject or theme?
- Summary: Key points in 1-2 sentences
${categoryHint ? `- Prefer category: ${categoryHint}` : ''}

TEXT: ${content}

JSON:`;

      const text = await this.callOpenRouter(prompt);
      return this.parseRichMetadataResponse(text, content, categoryHint);

    } catch (error) {
      console.error('Rich metadata extraction failed:', error);
      return this.getFallbackMetadata(content, categoryHint);
    }
  }

  /**
   * Extract metadata for multiple contents in batch (with rate limiting)
   */
  async extractRichMetadataBatch(
    contents: Array<{ content: string; category?: string }>
  ): Promise<Array<{ importance: number; topic: string; summary: string; category: string }>> {
    const results: Array<{ importance: number; topic: string; summary: string; category: string }> = [];

    // Process in batches to avoid rate limiting
    const batchSize = 3;
    for (let i = 0; i < contents.length; i += batchSize) {
      const batch = contents.slice(i, i + batchSize);
      const batchPromises = batch.map(item =>
        this.extractRichMetadata(item.content, item.category)
      );
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Small delay between batches to respect rate limits
      if (i + batchSize < contents.length) {
        await this.delay(500);
      }
    }

    return results;
  }

  private parseRichMetadataResponse(response: string, content: string, categoryHint?: string): {
    importance: number;
    topic: string;
    summary: string;
    category: string;
  } {
    try {
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/```\s*/, '').replace(/```\s*$/, '');
      }

      const parsed = JSON.parse(cleanResponse);

      return {
        importance: Math.max(1, Math.min(10, parsed.importance || 5)),
        topic: (parsed.topic || this.extractTopicFallback(content)).substring(0, 100),
        summary: (parsed.summary || content.substring(0, 200)).substring(0, 200),
        category: parsed.category || categoryHint || 'personal'
      };

    } catch (error) {
      console.error('Failed to parse rich metadata response:', error);
      return this.getFallbackMetadata(content, categoryHint);
    }
  }

  private getFallbackMetadata(content: string, categoryHint?: string): {
    importance: number;
    topic: string;
    summary: string;
    category: string;
  } {
    return {
      importance: 5,
      topic: this.extractTopicFallback(content),
      summary: content.substring(0, 200) + (content.length > 200 ? '...' : ''),
      category: categoryHint || 'personal'
    };
  }

  private extractTopicFallback(text: string): string {
    // Try to get first sentence
    const firstSentence = text.match(/^[^.!?]+[.!?]/);
    if (firstSentence) {
      return firstSentence[0].trim().substring(0, 100);
    }

    // Fallback: first 50 characters
    return text.substring(0, 50).trim() + (text.length > 50 ? '...' : '');
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
