/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview POST Nest TraitBatchApi/BatchUpdateState.
 */
import { type NestEndpoints } from '../settings';
import type { NestSession } from '../types/nest';
import { type FetchLike } from './http';
export interface BatchUpdateOptions {
    session: NestSession;
    endpoints: NestEndpoints;
    /** Encoded `nest.rpc.NestMessage` body. */
    body: Buffer;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}
/**
 * Send one BatchUpdateState request.
 *
 * The response body is protobuf (often empty-ish on success); callers care
 * about HTTP status, not a decoded payload.
 */
export declare function postBatchUpdateState(options: BatchUpdateOptions): Promise<void>;
