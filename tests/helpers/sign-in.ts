/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Placeholder Google sign-in values and token sources for tests.
 */

import type { NestToken, TokenSource } from '../../src/api/google-auth'

export const TEST_ISSUE_TOKEN =
  'https://accounts.google.com/o/oauth2/iframerpc?action=issueToken&response_type=token%20id_token&client_id=test-client'

export const TEST_COOKIES = 'SID=test-sid; HSID=test-hsid; SIDCC=test-sidcc'

/** The two sign-in settings, ready to spread into a platform config. */
export const TEST_SIGN_IN = { issueToken: TEST_ISSUE_TOKEN, cookies: TEST_COOKIES } as const

export interface FakeTokenSource extends TokenSource {
  /** Tokens handed out so far. */
  readonly minted: NestToken[]
}

/**
 * A token source that never touches the network.
 *
 * @param lifetimeMs How long each minted token lives.
 * @param fail Optional error to throw instead of minting.
 */
export function createTokenSource(options: { lifetimeMs?: number, fail?: () => Error } = {}): FakeTokenSource {
  const minted: NestToken[] = []
  return {
    minted,
    mintToken: async () => {
      if (options.fail) {
        throw options.fail()
      }
      const token = {
        value: `nest-token-${minted.length + 1}`,
        expiresAt: Date.now() + (options.lifetimeMs ?? 60 * 60_000),
      }
      minted.push(token)
      return token
    },
  }
}
