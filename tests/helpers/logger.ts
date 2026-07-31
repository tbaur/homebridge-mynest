/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview A logger that records what was written, for assertions.
 */

import type { Logger } from '../../src/utils/logger'

export interface RecordingLogger extends Logger {
  readonly debugs: string[]
  readonly infos: string[]
  readonly warns: string[]
  readonly errors: string[]
  /** Every level joined, for "was this mentioned anywhere" assertions. */
  all(): string
}

export function createRecordingLogger(): RecordingLogger {
  const debugs: string[] = []
  const infos: string[] = []
  const warns: string[] = []
  const errors: string[] = []

  const record = (sink: string[]) => (message: string, ...parameters: unknown[]): void => {
    sink.push([message, ...parameters.map(String)].join(' '))
  }

  return {
    debugs,
    infos,
    warns,
    errors,
    debug: record(debugs),
    info: record(infos),
    warn: record(warns),
    error: record(errors),
    all: () => [...debugs, ...infos, ...warns, ...errors].join('\n'),
  }
}
