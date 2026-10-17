/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest setup shared by every suite.
 */

const nock = require('nock')

// No test may reach the network. A Nest access token controls the home's
// thermostats and smoke alarms, so a stray real request from a test run is a
// genuine hazard rather than merely a flaky test.
beforeAll(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
})

afterAll(() => {
  nock.cleanAll()
  nock.enableNetConnect()
  // nock 15's restore() disposes the process-wide fetch interceptor.
  // Jest runs every file in one worker, and nothing can install that
  // interceptor again, so a later file would talk to the real network.
})
