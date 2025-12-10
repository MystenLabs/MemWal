/**
 * Test Setup for SEAL Integration Tests
 */

import { jest, beforeAll, afterAll } from '@jest/globals';
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'util';

// Setup for Jest/Node.js environment

// Polyfills for Node.js environment
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = NodeTextEncoder;
  globalThis.TextDecoder = NodeTextDecoder as typeof globalThis.TextDecoder;
}

// Increase test timeout for SEAL operations
jest.setTimeout(120000); // 2 minutes

// Mock console methods for cleaner test output
const originalConsole = console;

beforeAll(() => {
  console.log = jest.fn((...args: unknown[]) => {
    if (process.env.VERBOSE_TESTS === 'true') {
      originalConsole.log(...args);
    }
  }) as typeof console.log;
});

afterAll(() => {
  console.log = originalConsole.log;
});