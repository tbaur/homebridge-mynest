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
  // Per-area floors as well as a global one, set just under the current figures
  // so a regression fails the build. The global number alone is carried by small
  // fully-covered modules, which let the two largest and most consequential
  // files sit below the stated bar while the gate stayed green.
  coverageThreshold: {
    global: {
      branches: 83,
      functions: 94,
      lines: 92,
      statements: 92,
    },
    './src/api/': {
      branches: 80,
      functions: 91,
      lines: 90,
    },
    './src/platform.ts': {
      branches: 74,
      functions: 81,
      lines: 86,
    },
    './src/accessories/': {
      branches: 80,
      lines: 92,
    },
    './src/state/': {
      branches: 92,
      lines: 96,
    },
    './src/utils/': {
      branches: 92,
      lines: 97,
    },
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    // Type-only modules emit no runtime code, so they can never be covered.
    '!src/types/config.ts',
    '!src/types/nest.ts',
    '!src/diagnostics/types.ts',
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
