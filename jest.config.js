/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest configuration for sandboxed testing.
 * All tests run in isolation against synthesized fixtures; none touch the
 * network, and none contain data captured from a live Nest account.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      // Tests compile under the same strict settings as production
      // (see tsconfig.test.json) so type errors are caught consistently.
      tsconfig: 'tsconfig.test.json',
    }],
  },

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  maxWorkers: 1,

  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    // Only the entry point, not every index.ts. The glob form also catches
    // `src/errors/index.ts`, which is the error hierarchy rather than a barrel.
    '!src/index.ts',
    '!src/settings.ts', // Constants only
  ],

  testMatch: [
    '**/tests/unit/**/*.test.ts',
    '**/tests/integration/**/*.test.ts',
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
  ],

  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],

  testTimeout: 10000,
  verbose: true,
  // forceExit guarantees a clean shutdown after the suite. detectOpenHandles is
  // intentionally left off the standing config: it is a debugging aid (run via
  // `jest --detectOpenHandles` when chasing a hang) that reports false positives
  // for nock's mock sockets, which are not real leaks.
  forceExit: true,
}
