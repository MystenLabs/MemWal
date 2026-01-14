/**
 * Classification Namespace - Content Classification & Analysis
 *
 * Provides AI-powered classification for:
 * - Determining if content should be saved as memory
 * - Auto-categorizing content
 * - Pattern analysis
 * - Importance scoring
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';

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
 * Classification Namespace
 *
 * Handles AI-powered content classification
 */
export class ClassifyNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Determine if content should be saved as a memory
   *
   * Uses AI and pattern matching to decide if content is worth saving.
   *
   * @param content - Text content to analyze
   * @returns true if should save, false otherwise
   *
   * @example
   * ```typescript
   * const shouldSave = await pdw.classify.shouldSave('I love TypeScript');
   * if (shouldSave) {
   *   await pdw.memory.create('I love TypeScript');
   * }
   * ```
   */
  async shouldSave(content: string): Promise<boolean> {
    try {
      if (!this.services.classifier) {
        throw new Error('Classifier service not configured. Please provide geminiApiKey in config.');
      }

      const result = await this.services.classifier.shouldSaveMemory(content);
      return result.shouldSave;
    } catch (error) {
      throw new Error(`Classification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
   * const category = await pdw.classify.category('I prefer dark mode');
   * // Returns: 'preference'
   * ```
   */
  async category(content: string): Promise<string> {
    try {
      if (!this.services.classifier) {
        throw new Error('Classifier service not configured. Please provide geminiApiKey in config.');
      }

      // classifyContent returns string directly, not object
      const category = await this.services.classifier.classifyContent(content);
      return category;
    } catch (error) {
      throw new Error(`Category classification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
   * const analysis = await pdw.classify.patterns('My email is user@example.com');
   * // Returns: { patterns: [{ type: 'contact', ... }], suggestedCategory: 'contact' }
   * ```
   */
  async patterns(content: string): Promise<PatternAnalysis> {
    try {
      if (!this.services.classifier) {
        throw new Error('Classifier service not configured. Please provide geminiApiKey in config.');
      }

      const result = await this.services.classifier.analyzePatterns(content);

      return {
        patterns: result.patterns.map((p: string) => ({
          type: p,
          confidence: 1.0,
          examples: []
        })),
        categories: result.categories || [],
        suggestedCategory: result.categories[0] || 'general'  // Take first category
      };
    } catch (error) {
      throw new Error(`Pattern analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
   * const importance = await pdw.classify.importance('Emergency contact: 911');
   * // Returns: 10
   * ```
   */
  async importance(content: string): Promise<number> {
    try {
      if (!this.services.classifier) {
        throw new Error('Classifier service not configured. Please provide geminiApiKey in config.');
      }

      // classifyContent returns category string
      const category = await this.services.classifier.classifyContent(content);

      // Determine importance based on category
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
    } catch (error) {
      throw new Error(`Importance scoring failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
