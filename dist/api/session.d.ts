/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest session, opened with a Nest token from Google sign-in.
 *
 * Flow:
 *   1. `GET /session` with `Authorization: Basic <Nest token>` (see
 *      `google-auth.ts` for where the token comes from).
 *   2. Use the `access_token`, `userid`, and `urls.transport_url` from that
 *      response for every subsequent REST and Observe call, until the Nest
 *      token expires.
 */
import { type NestEndpoints } from '../settings';
import type { NestSession } from '../types/nest';
import type { Logger } from '../utils/logger';
import type { NestToken } from './google-auth';
import { type FetchLike } from './http';
export interface OpenSessionOptions {
    /** A freshly minted Nest token. */
    token: NestToken;
    endpoints: NestEndpoints;
    log: Logger;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
}
/** Standard headers for an authenticated REST call, once a session exists. */
export declare function authenticatedHeaders(session: NestSession): Record<string, string>;
/**
 * Exchange a Nest token for a usable session.
 *
 * @throws {AuthenticationError} When Nest rejects the token (HTTP 400 or 401).
 * @throws {SessionShapeError} When the response is accepted but omits a field
 *   the plugin needs, or names a transport host off Nest infrastructure. Either
 *   means Nest changed the contract; signing in again would not help.
 */
export declare function openSession(options: OpenSessionOptions): Promise<NestSession>;
