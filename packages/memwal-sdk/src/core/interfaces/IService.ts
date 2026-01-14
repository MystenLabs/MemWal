/**
 * Base Service Interface
 * 
 * Defines the standard interface that all services in the PDW SDK should implement.
 * Provides consistent lifecycle management, error handling, logging, and metrics.
 */

/**
 * Service lifecycle states
 */
export enum ServiceState {
  UNINITIALIZED = 'uninitialized',
  INITIALIZING = 'initializing',
  READY = 'ready',
  ERROR = 'error',
  DESTROYED = 'destroyed',
}

/**
 * Service configuration base interface
 */
export interface IServiceConfig {
  /** Service name for logging and metrics */
  name?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Enable metrics collection */
  enableMetrics?: boolean;
  /** Custom logger instance */
  logger?: ILogger;
}

/**
 * Logger interface for consistent logging across services
 */
export interface ILogger {
  debug(message: string, context?: Record<string, any>): void;
  info(message: string, context?: Record<string, any>): void;
  warn(message: string, context?: Record<string, any>): void;
  error(message: string, error?: Error, context?: Record<string, any>): void;
}

/**
 * Service metrics interface
 */
export interface IServiceMetrics {
  /** Total number of operations performed */
  operationCount: number;
  /** Total number of errors encountered */
  errorCount: number;
  /** Average operation duration in milliseconds */
  averageDuration: number;
  /** Last operation timestamp */
  lastOperationTime?: number;
  /** Service uptime in milliseconds */
  uptime: number;
  /** Custom metrics specific to the service */
  custom?: Record<string, number>;
}

/**
 * Base service interface that all services should implement
 */
export interface IService {
  /**
   * Service name for identification
   */
  readonly name: string;

  /**
   * Current service state
   */
  readonly state: ServiceState;

  /**
   * Initialize the service
   * Should be called before using the service
   * @returns Promise that resolves when initialization is complete
   */
  initialize?(): Promise<void>;

  /**
   * Destroy the service and cleanup resources
   * Should be called when the service is no longer needed
   * @returns Promise that resolves when cleanup is complete
   */
  destroy?(): Promise<void>;

  /**
   * Reset the service to initial state
   * Useful for testing or recovering from errors
   * @returns Promise that resolves when reset is complete
   */
  reset?(): Promise<void>;

  /**
   * Get service health status
   * @returns Health check result
   */
  getHealth?(): Promise<ServiceHealth>;

  /**
   * Get service metrics
   * @returns Current service metrics
   */
  getMetrics?(): IServiceMetrics;
}

/**
 * Service health check result
 */
export interface ServiceHealth {
  /** Whether the service is healthy */
  healthy: boolean;
  /** Service state */
  state: ServiceState;
  /** Health check timestamp */
  timestamp: number;
  /** Optional error message if unhealthy */
  error?: string;
  /** Additional health details */
  details?: Record<string, any>;
}

/**
 * Default console logger implementation
 */
export class ConsoleLogger implements ILogger {
  constructor(private serviceName: string, private debugEnabled: boolean = false) {}

  debug(message: string, context?: Record<string, any>): void {
    if (this.debugEnabled) {
      console.debug(`[${this.serviceName}] ${message}`, context || '');
    }
  }

  info(message: string, context?: Record<string, any>): void {
    console.log(`[${this.serviceName}] ${message}`, context || '');
  }

  warn(message: string, context?: Record<string, any>): void {
    console.warn(`[${this.serviceName}] ${message}`, context || '');
  }

  error(message: string, error?: Error, context?: Record<string, any>): void {
    console.error(`[${this.serviceName}] ${message}`, error, context || '');
  }
}

/**
 * Abstract base service class with common functionality
 */
export abstract class BaseService implements IService {
  protected _state: ServiceState = ServiceState.UNINITIALIZED;
  protected _logger: ILogger;
  protected _metrics: IServiceMetrics;
  protected _startTime: number;

  constructor(protected config: IServiceConfig) {
    this._logger = config.logger || new ConsoleLogger(
      config.name || this.constructor.name,
      config.debug || false
    );
    
    this._startTime = Date.now();
    
    this._metrics = {
      operationCount: 0,
      errorCount: 0,
      averageDuration: 0,
      uptime: 0,
      custom: {},
    };
  }

  get name(): string {
    return this.config.name || this.constructor.name;
  }

  get state(): ServiceState {
    return this._state;
  }

  async initialize(): Promise<void> {
    if (this._state !== ServiceState.UNINITIALIZED) {
      this._logger.warn('Service already initialized', { state: this._state });
      return;
    }

    this._state = ServiceState.INITIALIZING;
    this._logger.info('Initializing service...');

    try {
      await this.onInitialize();
      this._state = ServiceState.READY;
      this._logger.info('Service initialized successfully');
    } catch (error) {
      this._state = ServiceState.ERROR;
      this._logger.error('Service initialization failed', error as Error);
      throw error;
    }
  }

  async destroy(): Promise<void> {
    this._logger.info('Destroying service...');
    
    try {
      await this.onDestroy();
      this._state = ServiceState.DESTROYED;
      this._logger.info('Service destroyed successfully');
    } catch (error) {
      this._logger.error('Service destruction failed', error as Error);
      throw error;
    }
  }

  async reset(): Promise<void> {
    this._logger.info('Resetting service...');
    
    try {
      await this.onReset();
      this._metrics = {
        operationCount: 0,
        errorCount: 0,
        averageDuration: 0,
        uptime: 0,
        custom: {},
      };
      this._logger.info('Service reset successfully');
    } catch (error) {
      this._logger.error('Service reset failed', error as Error);
      throw error;
    }
  }

  async getHealth(): Promise<ServiceHealth> {
    return {
      healthy: this._state === ServiceState.READY,
      state: this._state,
      timestamp: Date.now(),
      details: {
        uptime: Date.now() - this._startTime,
        operationCount: this._metrics.operationCount,
        errorCount: this._metrics.errorCount,
      },
    };
  }

  getMetrics(): IServiceMetrics {
    return {
      ...this._metrics,
      uptime: Date.now() - this._startTime,
    };
  }

  /**
   * Track an operation for metrics
   */
  protected async trackOperation<T>(
    operationName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const startTime = performance.now();
    
    try {
      this._logger.debug(`Starting operation: ${operationName}`);
      const result = await operation();
      
      const duration = performance.now() - startTime;
      this.updateMetrics(duration);
      
      this._logger.debug(`Completed operation: ${operationName}`, { duration });
      return result;
    } catch (error) {
      this._metrics.errorCount++;
      this._logger.error(`Operation failed: ${operationName}`, error as Error);
      throw error;
    }
  }

  /**
   * Update metrics with operation duration
   */
  private updateMetrics(duration: number): void {
    this._metrics.operationCount++;
    
    // Calculate rolling average
    const totalDuration = this._metrics.averageDuration * (this._metrics.operationCount - 1);
    this._metrics.averageDuration = (totalDuration + duration) / this._metrics.operationCount;
  }

  /**
   * Hook for service-specific initialization
   */
  protected abstract onInitialize(): Promise<void>;

  /**
   * Hook for service-specific destruction
   */
  protected abstract onDestroy(): Promise<void>;

  /**
   * Hook for service-specific reset
   */
  protected abstract onReset(): Promise<void>;
}

