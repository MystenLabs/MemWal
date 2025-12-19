export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
    // Transform hnswlib-wasm ESM modules to CommonJS
    'node_modules/hnswlib-wasm/dist/.*\\.js$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  // Allow Jest to transform ES modules from node_modules
  transformIgnorePatterns: [
    'node_modules/(?!(hnswlib-wasm|@mysten/walrus|@mysten/seal)/)'
  ],
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx|js)',
    '**/*.(test|spec).+(ts|tsx|js)'
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/generated/**/*'
  ],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testTimeout: 60000, // 60 seconds for SEAL operations
  verbose: true,
  silent: false, // Show console.log output
};