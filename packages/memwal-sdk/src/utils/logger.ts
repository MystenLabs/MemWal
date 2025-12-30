/**
 * Structured Logging Utility for MemWal SDK
 * 
 * Provides context-aware logging with configurable levels and formatters.
 * Replaces direct console usage with a more maintainable and production-ready solution.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export interface LoggerConfig {
  /** Minimum log level to output */
  level?: LogLevel;
  /** Enable timestamps in logs */
  timestamps?: boolean;
  /** Custom log formatter */
  formatter?: LogFormatter;
  /** Enable in production (default: false) */
  enableInProduction?: boolean;
}

export interface LogEntry {
  level: LogLevel;
  context: string;
  message: string;
  timestamp: Date;
  data?: unknown;
  error?: Error;
}

export type LogFormatter = (entry: LogEntry) => string;

/**
 * Default log formatter
 */
const defaultFormatter: LogFormatter = (entry: LogEntry): string => {
  const timestamp = entry.timestamp.toISOString();
  const level = LogLevel[entry.level];
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  const error = entry.error ? ` ${entry.error.message}` : '';
  return `[${timestamp}] [${level}] [${entry.context}] ${entry.message}${data}${error}`;
};

/**
 * Simple formatter without timestamps (for development)
 */
const simpleFormatter: LogFormatter = (entry: LogEntry): string => {
  const level = LogLevel[entry.level];
  const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  return `[${level}] [${entry.context}] ${entry.message}${data}`;
};

/**
 * Global logger configuration
 */
class LoggerManager {
  private static instance: LoggerManager;
  private config: Required<LoggerConfig>;

  private constructor() {
    // Compute default level using static helper to avoid accessing 'this.config' before initialization
    const defaultLevel = LoggerManager.getDefaultLevelStatic();
    
    this.config = {
      level: defaultLevel,
      timestamps: true,
      formatter: defaultFormatter,
      enableInProduction: false,
    };
  }

  static getInstance(): LoggerManager {
    if (!LoggerManager.instance) {
      LoggerManager.instance = new LoggerManager();
    }
    return LoggerManager.instance;
  }

  /**
   * Static method to determine default log level based on environment
   * Used during initialization to avoid accessing instance before it's ready
   */
  private static getDefaultLevelStatic(): LogLevel {
    const isProduction = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
    const isBrowser = typeof window !== 'undefined';
    
    if (isProduction) {
      return LogLevel.WARN; // Only warn and error in production by default
    }
    
    if (isBrowser) {
      return LogLevel.INFO; // More verbose in browser for debugging
    }
    
    return LogLevel.DEBUG; // Most verbose in Node.js development
  }

  private getDefaultLevel(): LogLevel {
    return LoggerManager.getDefaultLevelStatic();
  }

  configure(config: LoggerConfig): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  getConfig(): Required<LoggerConfig> {
    return this.config;
  }

  shouldLog(level: LogLevel): boolean {
    return level >= this.config.level;
  }

  format(entry: LogEntry): string {
    return this.config.formatter(entry);
  }
}

/**
 * Logger class for context-aware logging
 */
export class Logger {
  private context: string;
  private manager: LoggerManager;

  constructor(context: string) {
    this.context = context;
    this.manager = LoggerManager.getInstance();
  }

  /**
   * Log debug information (development only)
   */
  debug(message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  /**
   * Log informational messages
   */
  info(message: string, data?: unknown): void {
    this.log(LogLevel.INFO, message, data);
  }

  /**
   * Log warning messages
   */
  warn(message: string, data?: unknown): void {
    this.log(LogLevel.WARN, message, data);
  }

  /**
   * Log error messages
   */
  error(message: string, error?: Error | unknown, data?: unknown): void {
    const errorObj = error instanceof Error ? error : undefined;
    const errorData = error instanceof Error ? data : error;
    this.log(LogLevel.ERROR, message, errorData, errorObj);
  }

  /**
   * Internal logging method
   */
  private log(level: LogLevel, message: string, data?: unknown, error?: Error): void {
    if (!this.manager.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      level,
      context: this.context,
      message,
      timestamp: new Date(),
      data,
      error,
    };

    const formatted = this.manager.format(entry);

    // Output to appropriate console method
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(formatted);
        break;
      case LogLevel.INFO:
        console.info(formatted);
        break;
      case LogLevel.WARN:
        console.warn(formatted);
        break;
      case LogLevel.ERROR:
        console.error(formatted, error);
        break;
    }
  }
}

/**
 * Configure global logger settings
 */
export function configureLogger(config: LoggerConfig): void {
  LoggerManager.getInstance().configure(config);
}

/**
 * Create a logger for a specific context
 */
export function createLogger(context: string): Logger {
  return new Logger(context);
}

/**
 * Export formatters
 */
export const LogFormatters = {
  default: defaultFormatter,
  simple: simpleFormatter,
};

/**
 * Default logger instance (for quick usage)
 */
export const logger = new Logger('MemWal');
