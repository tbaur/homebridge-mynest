/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Nest Account session, the only authentication path supported.
 *
 * Flow:
 *   1. `GET /session` with `Authorization: Basic <configured access_token>`.
 *   2. Use the `access_token`, `userid`, and `urls.transport_url` from that
 *      response for every subsequent REST and Observe call.
 *
 * Google account sign-in is deliberately not implemented. It requires
 * replaying a browser cookie through Google's own `issueToken` flow, which
 * Google changes without notice and which asks the user to paste a credential
 * covering their entire Google account rather than just their Nest home.
 */
import { type NestEndpoints } from '../settings';
import type { NestSession } from '../types/nest';
import type { Logger } from '../utils/logger';
import { type FetchLike } from './http';
export interface OpenSessionOptions {
    /** The token from the user's config, not from a previous session. */
    accessToken: string;
    endpoints: NestEndpoints;
    log: Logger;
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
}
/** Standard headers for an authenticated REST call, once a session exists. */
export declare function authenticatedHeaders(session: NestSession): Record<string, string>;
/**
 * Exchange the configured access token for a usable session.
 *
 * @throws {AuthenticationError} When Nest rejects the token.
 * @throws {SessionShapeError} When the response is accepted but omits a field
 *   the plugin needs, which means Nest changed the contract.
 */
export declare function openSession(options: OpenSessionOptions): Promise<NestSession>;
