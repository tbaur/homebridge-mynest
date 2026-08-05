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
  // Per-area floors, each set just under the current figure so a regression
  // fails the build.
  //
  // Two things to know before editing this. First, a path key REMOVES its
  // matching files from the `global` pool — it does not add a second gate on top
  // of it. So `global` here only covers what no path key matches (`index.ts`,
  // `settings.ts`, `types/device.ts`), and every area that matters needs its own
  // key or it is ungated. Second, every key must list all four metrics: a key
  // that omits `statements` leaves statements unmeasured for those files
  // entirely. Both mistakes were live here, and made the advertised gate far
  // weaker than it looked.
  coverageThreshold: {
    // Residual pool only: the files no path key below matches.
    global: {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
    './src/api/': {
      branches: 79,
      functions: 90,
      lines: 90,
      statements: 90,
    },
    './src/platform.ts': {
      branches: 74,
      functions: 81,
      lines: 86,
      statements: 86,
    },
    './src/accessories/': {
      branches: 81,
      functions: 99,
      lines: 92,
      statements: 92,
    },
    './src/state/': {
      branches: 93,
      functions: 99,
      lines: 97,
      statements: 97,
    },
    './src/utils/': {
      branches: 92,
      functions: 99,
      lines: 97,
      statements: 97,
    },
    './src/diagnostics/': {
      branches: 89,
      functions: 99,
      lines: 96,
      statements: 96,
    },
    './src/errors/': {
      branches: 89,
      functions: 99,
      lines: 98,
      statements: 98,
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
