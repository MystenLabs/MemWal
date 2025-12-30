# Using New SDK Utilities

This guide demonstrates how to use the newly added utilities for logging and environment validation.

## Structured Logging

The new `Logger` utility provides context-aware, structured logging with configurable levels.

### Basic Usage

```typescript
import { createLogger, LogLevel } from '@cmdoss/memwal-sdk';

// Create a logger for your module
const logger = createLogger('MyService');

// Log at different levels
logger.debug('Detailed debug information', { userId: '123' });
logger.info('Operation completed successfully');
logger.warn('This operation is deprecated');
logger.error('Operation failed', new Error('Network timeout'));
```

### Configure Global Logger

```typescript
import { configureLogger, LogLevel, LogFormatters } from '@cmdoss/memwal-sdk';

// Configure logger settings at app startup
configureLogger({
  level: LogLevel.INFO,           // Minimum level to log
  timestamps: true,                // Include timestamps
  formatter: LogFormatters.simple, // Use simple formatter
  enableInProduction: false,       // Disable debug/info in production
});
```

### Migration from console

**Before:**
```typescript
console.log('Processing memory:', memoryId);
console.warn('Feature not yet implemented');
console.error('Failed to upload:', error);
```

**After:**
```typescript
const logger = createLogger('MemoryService');
logger.info('Processing memory', { memoryId });
logger.warn('Feature not yet implemented');
logger.error('Failed to upload', error);
```

### Log Levels

- `DEBUG` (0): Detailed debugging information (development only)
- `INFO` (1): General informational messages
- `WARN` (2): Warning messages for potentially problematic situations
- `ERROR` (3): Error messages for failures
- `NONE` (4): Disable all logging

## Environment Validation

The new environment validation utility provides runtime checks for required configuration.

### Validate All Environment Variables

```typescript
import { validateEnvOrThrow, SDKEnvSchema } from '@cmdoss/memwal-sdk';

// Validate at app startup
try {
  const env = validateEnvOrThrow(SDKEnvSchema);
  console.log('Environment configuration valid');
} catch (error) {
  console.error('Invalid configuration:', error.message);
  process.exit(1);
}
```

### Check Feature Requirements

```typescript
import { 
  checkFeatureRequirements, 
  FeatureRequirements,
  getFeatureRequirementError 
} from '@cmdoss/memwal-sdk';

// Check if AI embedding is available
const embeddingCheck = checkFeatureRequirements(FeatureRequirements.EMBEDDING);
if (!embeddingCheck.available) {
  console.log('Missing:', embeddingCheck.missing);
  // Output: Missing: ['GEMINI_API_KEY']
}

// Get user-friendly error message
const error = getFeatureRequirementError(FeatureRequirements.EMBEDDING);
if (error) {
  console.error(error);
  // Output: Feature "AI Embedding" is not available. Missing environment variables: GEMINI_API_KEY
}
```

### Available Feature Checks

```typescript
import { FeatureRequirements } from '@cmdoss/memwal-sdk';

// Check different features
FeatureRequirements.EMBEDDING    // Requires: GEMINI_API_KEY
FeatureRequirements.BLOCKCHAIN   // Requires: PACKAGE_ID, SUI_NETWORK
FeatureRequirements.WALLET       // Requires: SUI_PRIVATE_KEY, WALLET_ADDRESS
FeatureRequirements.WALRUS       // Requires: WALRUS_PUBLISHER, WALRUS_AGGREGATOR
FeatureRequirements.SEAL         // Requires: SEAL_KEY_SERVER_URL, SEAL_NETWORK
FeatureRequirements.MEMORY_INDEX // Requires: MEMORY_INDEX_ID
```

### Validate Minimum Requirements

```typescript
import { validateMinimumRequirements } from '@cmdoss/memwal-sdk';

const validation = validateMinimumRequirements();

if (!validation.valid) {
  console.error('Configuration errors:', validation.errors);
}

if (validation.warnings.length > 0) {
  console.warn('Configuration warnings:', validation.warnings);
}
```

### Get Environment Variables Safely

```typescript
import { getEnvVar, getRequiredEnvVar } from '@cmdoss/memwal-sdk';

// Get optional variable with fallback
const network = getEnvVar('SUI_NETWORK', 'testnet');

// Get required variable or throw
try {
  const apiKey = getRequiredEnvVar('GEMINI_API_KEY');
} catch (error) {
  console.error('Missing required config:', error.message);
}
```

### Next.js Public Variables

For Next.js applications, validate public environment variables:

```typescript
import { validateEnvOrThrow, NextPublicEnvSchema } from '@cmdoss/memwal-sdk';

// In Next.js config or _app.tsx
const publicEnv = validateEnvOrThrow(NextPublicEnvSchema, process.env, 'Next.js');
```

## Integration Example

Here's how to integrate both utilities in your application:

```typescript
import {
  createLogger,
  configureLogger,
  LogLevel,
  validateMinimumRequirements,
  checkFeatureRequirements,
  FeatureRequirements,
} from '@cmdoss/memwal-sdk';

// Configure logging at startup
configureLogger({
  level: process.env.NODE_ENV === 'production' ? LogLevel.WARN : LogLevel.DEBUG,
  timestamps: true,
  enableInProduction: false,
});

const logger = createLogger('AppInitializer');

// Validate environment
logger.info('Validating environment configuration...');
const validation = validateMinimumRequirements();

if (!validation.valid) {
  validation.errors.forEach(error => logger.error(error));
  throw new Error('Invalid configuration');
}

if (validation.warnings.length > 0) {
  validation.warnings.forEach(warning => logger.warn(warning));
}

// Check feature availability
const features = {
  embedding: checkFeatureRequirements(FeatureRequirements.EMBEDDING).available,
  blockchain: checkFeatureRequirements(FeatureRequirements.BLOCKCHAIN).available,
  encryption: checkFeatureRequirements(FeatureRequirements.SEAL).available,
};

logger.info('Available features:', features);

// Initialize SDK with validated config
// ... your SDK initialization code
```

## Benefits

### Structured Logging
- ✅ Context-aware logging (know which component logged what)
- ✅ Configurable log levels (control verbosity)
- ✅ Production-safe (disable verbose logs in production)
- ✅ Structured data (easier to parse and analyze)
- ✅ Better debugging (consistent format across codebase)

### Environment Validation
- ✅ Fail fast (catch config errors at startup, not runtime)
- ✅ Type-safe (validated against Zod schemas)
- ✅ User-friendly (helpful error messages)
- ✅ Feature detection (know what's available)
- ✅ Documentation (schemas document required config)

## Next Steps

1. **Migrate console statements**: Replace existing `console.log/warn/error` with `Logger`
2. **Add validation**: Call `validateMinimumRequirements()` at SDK initialization
3. **Document features**: Update user docs with feature requirements
4. **Add to CI**: Run validation in CI/CD pipeline
