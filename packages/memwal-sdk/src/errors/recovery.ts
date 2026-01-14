/**
 * Retry and Recovery Utilities for Personal Data Wallet SDK
 * 
 * Provides automatic retry logic, circuit breaker patterns,
 * and error recovery strategies for resilient operations.
 */

import { PDWError, isPDWError, NetworkError, TimeoutError, ValidationError } from './index';

// ==================== RETRY CONFIGURATION ====================

export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Initial delay between retries in milliseconds */
  initialDelay: number;
  /** Maximum delay between retries in milliseconds */
  maxDelay: number;
  /** Backoff multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Whether to add random jitter to delays */
  jitter: boolean;
  /** Function to determine if error should be retried */
  shouldRetry?: (error: any, attempt: number) => boolean;
  /** Function called before each retry attempt */
  onRetry?: (error: any, attempt: number, delay: number) => void;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
  jitter: true,
  shouldRetry: (error: any) => {
    if (isPDWError(error)) {
      return error.isRetryable();
    }
    // Retry network errors, timeouts, and temporary failures
    return error?.code === 'ECONNRESET' ||
           error?.code === 'ENOTFOUND' ||
           error?.code === 'TIMEOUT' ||
           error?.status >= 500;
  },
  onRetry: (error, attempt, delay) => {
    console.warn(`Retry attempt ${attempt} after ${delay}ms due to:`, error.message);
  },
};

// ==================== RETRY FUNCTION ====================

/**
 * Execute a function with automatic retry logic
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: any;
  
  for (let attempt = 1; attempt <= finalConfig.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      // Check if we should retry
      if (attempt >= finalConfig.maxAttempts || 
          !finalConfig.shouldRetry!(error, attempt)) {
        throw error;
      }
      
      // Calculate delay with exponential backoff and jitter
      const baseDelay = Math.min(
        finalConfig.initialDelay * Math.pow(finalConfig.backoffMultiplier, attempt - 1),
        finalConfig.maxDelay
      );
      
      const jitter = finalConfig.jitter ? 
        Math.random() * 0.1 * baseDelay : 0;
      
      const delay = Math.floor(baseDelay + jitter);
      
      // Call retry callback
      if (finalConfig.onRetry) {
        finalConfig.onRetry(error, attempt, delay);
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

// ==================== CIRCUIT BREAKER ====================

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in milliseconds to wait before attempting to close circuit */
  resetTimeout: number;
  /** Minimum number of calls before circuit can open */
  minimumCalls: number;
  /** Success ratio threshold to close circuit (0-1) */
  successThreshold: number;
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private totalCalls = 0;
  private lastFailureTime = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: 5,
      resetTimeout: 30000,
      minimumCalls: 10,
      successThreshold: 0.8,
      ...config,
    };
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.config.resetTimeout) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
        this.totalCalls = 0;
      } else {
        throw new NetworkError(
          'Circuit breaker is open - service temporarily unavailable',
          'CIRCUIT_BREAKER_OPEN'
        );
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.successCount++;
    this.totalCalls++;
    
    if (this.state === CircuitState.HALF_OPEN) {
      const successRatio = this.successCount / this.totalCalls;
      if (this.totalCalls >= this.config.minimumCalls && 
          successRatio >= this.config.successThreshold) {
        this.reset();
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.totalCalls++;
    this.lastFailureTime = Date.now();
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
    } else if (this.failureCount >= this.config.failureThreshold &&
               this.totalCalls >= this.config.minimumCalls) {
      this.state = CircuitState.OPEN;
    }
  }

  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.totalCalls = 0;
  }

  getState(): CircuitState {
    return this.state;
  }

  getMetrics() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalCalls: this.totalCalls,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

// ==================== RATE LIMITER ====================

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async acquire(tokens = 1): Promise<void> {
    this.refill();
    
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return;
    }
    
    // Wait for tokens to be available
    const tokensNeeded = tokens - this.tokens;
    const waitTime = (tokensNeeded / this.refillRate) * 1000;
    
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    this.refill();
    this.tokens -= tokens;
  }

  private refill(): void {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000;
    const tokensToAdd = timePassed * this.refillRate;
    
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  getTokens(): number {
    this.refill();
    return this.tokens;
  }
}

// ==================== RECOVERY STRATEGIES ====================

export interface RecoveryStrategy<T> {
  canRecover(error: any): boolean;
  recover(error: any, originalOperation: () => Promise<T>): Promise<T>;
}

export class FallbackRecovery<T> implements RecoveryStrategy<T> {
  constructor(
    private fallbackOperation: (error: any) => Promise<T>,
    private canRecoverFn: (error: any) => boolean = () => true
  ) {}

  canRecover(error: any): boolean {
    return this.canRecoverFn(error);
  }

  async recover(error: any): Promise<T> {
    return this.fallbackOperation(error);
  }
}

export class CacheRecovery<T> implements RecoveryStrategy<T> {
  private cache = new Map<string, { data: T; timestamp: number }>();

  constructor(
    private keyGenerator: (...args: any[]) => string,
    private ttl: number = 300000 // 5 minutes
  ) {}

  canRecover(error: any): boolean {
    return isPDWError(error) && 
           (error.code === 'NETWORK_ERROR' || 
            error.code === 'TIMEOUT_ERROR' ||
            error.code === 'CONNECTION_ERROR');
  }

  async recover(error: any, originalOperation: () => Promise<T>): Promise<T> {
    // This is a simplified recovery - in practice, you'd need access to the original arguments
    throw new Error('Cache recovery requires implementation context');
  }

  setCacheEntry(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  getCacheEntry(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }
}

// ==================== RESILIENT OPERATION WRAPPER ====================

export interface ResilienceConfig {
  retry?: Partial<RetryConfig>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  rateLimiter?: { capacity: number; refillRate: number };
  recoveryStrategies?: RecoveryStrategy<any>[];
}

export class ResilientOperation<T> {
  private circuitBreaker?: CircuitBreaker;
  private rateLimiter?: RateLimiter;
  private retryConfig: RetryConfig;
  private recoveryStrategies: RecoveryStrategy<T>[];

  constructor(config: ResilienceConfig = {}) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config.retry };
    
    if (config.circuitBreaker) {
      this.circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    }
    
    if (config.rateLimiter) {
      this.rateLimiter = new RateLimiter(
        config.rateLimiter.capacity,
        config.rateLimiter.refillRate
      );
    }
    
    this.recoveryStrategies = config.recoveryStrategies || [];
  }

  async execute(operation: () => Promise<T>): Promise<T> {
    // Apply rate limiting
    if (this.rateLimiter) {
      await this.rateLimiter.acquire();
    }

    const executeWithCircuitBreaker = this.circuitBreaker ?
      () => this.circuitBreaker!.execute(operation) :
      operation;

    try {
      return await withRetry(executeWithCircuitBreaker, this.retryConfig);
    } catch (error) {
      // Try recovery strategies
      for (const strategy of this.recoveryStrategies) {
        if (strategy.canRecover(error)) {
          try {
            return await strategy.recover(error, operation);
          } catch (recoveryError) {
            // If recovery fails, continue to next strategy
            continue;
          }
        }
      }
      
      // If no recovery worked, throw the original error
      throw error;
    }
  }
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Create a resilient version of an async function
 */
export function makeResilient<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  config: ResilienceConfig = {}
): (...args: T) => Promise<R> {
  const resilientOp = new ResilientOperation<R>(config);
  
  return (...args: T) => {
    return resilientOp.execute(() => fn(...args));
  };
}

/**
 * Delay execution for a specified time
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a timeout wrapper for promises
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage = 'Operation timed out'
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new TimeoutError('operation', timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}

/**
 * Batch operations with concurrency control
 */
export async function batch<T, R>(
  items: T[],
  operation: (item: T, index: number) => Promise<R>,
  concurrency = 5
): Promise<R[]> {
  const results: R[] = [];
  const errors: Array<{ index: number; error: any }> = [];
  
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const promises = batch.map((item, batchIndex) => 
      operation(item, i + batchIndex)
        .catch(error => ({ error, index: i + batchIndex }))
    );
    
    const batchResults = await Promise.all(promises);
    
    batchResults.forEach((result, batchIndex) => {
      if (result && typeof result === 'object' && 'error' in result) {
        errors.push(result as { index: number; error: any });
      } else {
        results[i + batchIndex] = result as R;
      }
    });
  }
  
  if (errors.length > 0) {
    throw new ValidationError(
      `Batch operation failed for ${errors.length} items`,
      'batch',
      { errors: errors.map(e => ({ index: e.index, message: e.error.message })) }
    );
  }
  
  return results;
}