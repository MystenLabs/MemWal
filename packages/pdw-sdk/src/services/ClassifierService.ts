/**
 * ClassifierService - Content Classification and Filtering
 * 
 * Determines if content should be saved as memory using pattern matching
 * and AI classification. Provides category classification for content organization.
 */

import { EmbeddingService } from './EmbeddingService';
import type { ClientWithCoreApi, PDWConfig } from '../types';

export interface ClassificationResult {
  shouldSave: boolean;
  confidence: number;
  category: string;
  reasoning: string;
}

export interface ClassificationOptions {
  useAI?: boolean;
  confidenceThreshold?: number;
  categories?: string[];
  patterns?: RegExp[];
}

export interface PatternAnalysisResult {
  patterns: string[];
  categories: string[];
  matches: Array<{
    pattern: string;
    match: string;
    category: string;
    confidence: number;
  }>;
}

/**
 * Content classification service for determining memory worthiness
 */
export class ClassifierService {
  private embeddingService?: EmbeddingService;
  private aiApiKey?: string;
  
  // Regex patterns for detecting factual statements (adapted from backend)
  private readonly factPatterns: RegExp[] = [
    // Personal information
    /my name is ([a-zA-Z\s]+)/i,
    /my email is ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
    /i live in ([a-zA-Z\s,]+)/i,
    /i work at ([a-zA-Z\s,&]+)/i,
    /i am from ([a-zA-Z\s,]+)/i,
    /i was born in ([a-zA-Z0-9\s,]+)/i,
    /my birthday is ([a-zA-Z0-9\s,]+)/i,
    /my phone (?:number|#) is ([0-9+\-\s()]+)/i,
    /my address is ([a-zA-Z0-9\s,]+)/i,

    // Preferences and likes/dislikes
    /i love ([^.!?]+)/i,
    /i like ([^.!?]+)/i,
    /i enjoy ([^.!?]+)/i,
    /i prefer ([^.!?]+)/i,
    /i hate ([^.!?]+)/i,
    /i dislike ([^.!?]+)/i,
    /i don't like ([^.!?]+)/i,
    /my favorite ([^.!?]+) is ([^.!?]+)/i,
    /my favourite ([^.!?]+) is ([^.!?]+)/i,

    // Explicit memory requests
    /remember that ([^.!?]+)/i,
    /don't forget that ([^.!?]+)/i,
    /please remember ([^.!?]+)/i,

    // Personal facts
    /i am ([^.!?]+)/i,
    /i have ([^.!?]+)/i,
    /i own ([^.!?]+)/i,
    /i studied ([^.!?]+)/i,
    /i graduated from ([^.!?]+)/i,
  ];
  
  // Map of regex patterns to categories (adapted from backend)
  private readonly categoryMap: Record<string, string> = {
    // Personal information
    'my name is': 'personal_info',
    'my email is': 'contact',
    'i live in': 'location',
    'i work at': 'career',
    'i am from': 'background',
    'i was born': 'background',
    'my birthday': 'personal_info',
    'my phone': 'contact',
    'my address': 'contact',

    // Preferences
    'i love': 'preference',
    'i like': 'preference',
    'i enjoy': 'preference',
    'i prefer': 'preference',
    'i hate': 'preference',
    'i dislike': 'preference',
    "i don't like": 'preference',
    'my favorite': 'preference',
    'my favourite': 'preference',

    // Explicit memory requests
    'remember that': 'custom',
    "don't forget": 'custom',
    'please remember': 'custom',

    // Personal facts
    'i am': 'personal_info',
    'i have': 'personal_info',
    'i own': 'personal_info',
    'i studied': 'education',
    'i graduated': 'education',
  };

  constructor(
    private client?: ClientWithCoreApi,
    private config?: PDWConfig,
    embeddingService?: EmbeddingService,
    aiApiKey?: string
  ) {
    this.embeddingService = embeddingService;
    this.aiApiKey = aiApiKey;
  }

  /**
   * Determine if a message contains information worth saving
   * @param message User message to classify
   * @param options Classification options
   * @returns Classification result
   */
  async shouldSaveMemory(message: string, options: ClassificationOptions = {}): Promise<ClassificationResult> {
    try {
      // Input validation
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return {
          shouldSave: false,
          confidence: 0,
          category: 'general',
          reasoning: 'Empty or invalid message'
        };
      }

      const {
        useAI = true,
        confidenceThreshold = 0.7,
        patterns = this.factPatterns
      } = options;

      // Step 1: Check for obvious patterns using regex
      const patternResult = this.matchPatterns(message, patterns);
      if (patternResult.matched && patternResult.confidence >= confidenceThreshold) {
        return {
          shouldSave: true,
          confidence: patternResult.confidence,
          category: patternResult.category,
          reasoning: `Matched pattern: ${patternResult.pattern}`
        };
      }

      // Step 2: Use AI for more complex classification (if enabled and available)
      if (useAI && (this.embeddingService || this.aiApiKey)) {
        try {
          const aiResult = await this.classifyWithAI(message, options);
          if (aiResult.confidence >= confidenceThreshold) {
            return aiResult;
          }
        } catch (aiError) {
          if (process.env.NODE_ENV === 'development') {
            const errorMessage = aiError instanceof Error ? aiError.message : String(aiError);
            console.warn('AI classification failed, falling back to pattern-only result:', errorMessage);
          }
        }
      }

      // Step 3: Return pattern result even if below threshold
      if (patternResult.matched) {
        return {
          shouldSave: patternResult.confidence >= confidenceThreshold,
          confidence: patternResult.confidence,
          category: patternResult.category,
          reasoning: `Pattern match (confidence: ${patternResult.confidence})`
        };
      }

      // Step 4: Default to not saving
      return {
        shouldSave: false,
        confidence: 0.1,
        category: 'general',
        reasoning: 'No significant patterns detected and AI classification unavailable or inconclusive'
      };

    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('Error in classification:', error);
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        shouldSave: false,
        confidence: 0,
        category: 'error',
        reasoning: `Classification error: ${errorMessage}`
      };
    }
  }

  /**
   * Classify content into categories
   * @param content Content to classify
   * @param options Classification options
   * @returns Category string
   */
  async classifyContent(content: string, options: ClassificationOptions = {}): Promise<string> {
    const result = await this.shouldSaveMemory(content, options);
    return result.category;
  }

  /**
   * Analyze patterns in text
   * @param text Text to analyze
   * @param patterns Optional custom patterns
   * @returns Pattern analysis result
   */
  async analyzePatterns(text: string, patterns: RegExp[] = this.factPatterns): Promise<PatternAnalysisResult> {
    const matches: Array<{
      pattern: string;
      match: string;
      category: string;
      confidence: number;
    }> = [];
    const foundPatterns: string[] = [];
    const foundCategories: string[] = [];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const patternStr = pattern.toString();
        const category = this.getCategoryForPattern(patternStr);
        const confidence = this.calculatePatternConfidence(pattern, match[0]);
        
        matches.push({
          pattern: patternStr,
          match: match[0],
          category,
          confidence
        });
        
        if (!foundPatterns.includes(patternStr)) {
          foundPatterns.push(patternStr);
        }
        
        if (!foundCategories.includes(category)) {
          foundCategories.push(category);
        }
      }
    }

    return {
      patterns: foundPatterns,
      categories: foundCategories,
      matches
    };
  }

  /**
   * Match patterns against text
   * @param text Text to match
   * @param patterns Patterns to use
   * @returns Match result
   */
  private matchPatterns(text: string, patterns: RegExp[]): {
    matched: boolean;
    pattern?: string;
    category: string;
    confidence: number;
  } {
    // Handle null/undefined text input
    if (!text || typeof text !== 'string') {
      return {
        matched: false,
        category: 'general',
        confidence: 0.1
      };
    }

    for (const pattern of patterns) {
      try {
        const match = text.match(pattern);
        if (match) {
          const patternStr = pattern.toString();
          const category = this.getCategoryForPattern(patternStr);
          const confidence = this.calculatePatternConfidence(pattern, match[0]);
          
          return {
            matched: true,
            pattern: patternStr,
            category,
            confidence
          };
        }
      } catch (error) {
        // Skip invalid patterns
        if (process.env.NODE_ENV === 'development') {
          console.warn(`Pattern matching error for pattern ${pattern}:`, error);
        }
      }
    }

    return {
      matched: false,
      category: 'general',
      confidence: 0.1
    };
  }

  /**
   * Get category for a regex pattern
   * @param patternString String representation of the regex
   * @returns Category string
   */
  private getCategoryForPattern(patternString: string): string {
    // Extract the key part of the pattern for lookup
    const patternCore = patternString.toLowerCase()
      .replace(/^\/|\/[a-z]*$/g, '') // Remove regex delimiters
      .replace(/\([^)]*\)/g, '') // Remove capture groups
      .replace(/\[[^\]]*\]/g, '') // Remove character classes
      .replace(/[+*?{}|\\^$]/g, '') // Remove regex metacharacters
      .trim();

    // Find the best matching category
    for (const [key, category] of Object.entries(this.categoryMap)) {
      if (patternCore.includes(key.toLowerCase()) || key.toLowerCase().includes(patternCore)) {
        return category;
      }
    }

    return 'custom';
  }

  /**
   * Calculate confidence score for pattern match
   * @param pattern The regex pattern
   * @param match The matched text
   * @returns Confidence score (0-1)
   */
  private calculatePatternConfidence(pattern: RegExp, match: string): number {
    // Base confidence for any pattern match
    let confidence = 0.85;

    // Higher confidence for explicit statements
    if (pattern.source.includes('my name is') || 
        pattern.source.includes('remember that') ||
        pattern.source.includes('don\'t forget')) {
      confidence = 0.95;
    }

    // Higher confidence for specific patterns (email, phone, etc.)
    if (pattern.source.includes('@') || pattern.source.includes('[0-9]')) {
      confidence = 0.92;
    }

    // Adjust based on match length (longer matches tend to be more specific)
    if (match.length > 30) {
      confidence = Math.min(confidence + 0.05, 1.0);
    }

    return confidence;
  }

  /**
   * Use AI for classification (fallback/enhancement)
   * @param message Message to classify
   * @param options Classification options
   * @returns Classification result
   */
  private async classifyWithAI(message: string, options: ClassificationOptions): Promise<ClassificationResult> {
    // For now, this is a placeholder that could integrate with:
    // 1. EmbeddingService for semantic similarity
    // 2. External AI APIs (OpenAI, Gemini, etc.)
    // 3. Local AI models
    
    if (this.embeddingService) {
      // Use embedding-based classification
      return await this.classifyWithEmbeddings(message, options);
    }

    // If no AI service is available, return low-confidence result
    return {
      shouldSave: false,
      confidence: 0.3,
      category: 'general',
      reasoning: 'AI classification not available'
    };
  }

  /**
   * Classify using embeddings (semantic similarity approach)
   * @param message Message to classify
   * @param options Classification options
   * @returns Classification result
   */
  private async classifyWithEmbeddings(message: string, options: ClassificationOptions): Promise<ClassificationResult> {
    if (!this.embeddingService) {
      throw new Error('EmbeddingService not available');
    }

    try {
      // Generate embedding for the message
      const result = await this.embeddingService.embedText({ text: message, type: 'content' });
      
      // For now, use simple heuristics based on common memory-worthy patterns
      // In a full implementation, this would compare against a database of 
      // known memory-worthy content embeddings
      
      const messageWords = message.toLowerCase().split(/\s+/);
      const memoryKeywords = ['i', 'my', 'me', 'like', 'love', 'hate', 'prefer', 'enjoy', 'am', 'work', 'live'];
      const memoryWordCount = messageWords.filter(word => memoryKeywords.includes(word)).length;
      
      const confidence = Math.min(memoryWordCount * 0.15 + 0.1, 0.85);
      const shouldSave = confidence > 0.6;
      
      return {
        shouldSave,
        confidence,
        category: shouldSave ? 'personal_info' : 'general',
        reasoning: `Embedding-based classification (${memoryWordCount} memory keywords found)`
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Embedding classification failed: ${errorMessage}`);
    }
  }
}