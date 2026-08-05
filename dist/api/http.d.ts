/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared HTTP plumbing for the Nest REST endpoints.
 *
 * The one subtlety here is abort handling. The REST `subscribe` call is a long
 * poll that the *client* is expected to end, so "the request was aborted" is
 * both the normal idle outcome and the shutdown signal, and the two must be
 * told apart. {@link sendRequest} therefore reports which of its own deadlines
 * fired instead of collapsing everything into one `AbortError`.
 */
/** Node's global `fetch`, or a substitute supplied by tests. */
export type FetchLike = typeof globalThis.fetch;
export interface SendOptions {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    /** JSON string for REST, or raw protobuf bytes for BatchUpdateState. */
    body?: string | Buffer | Uint8Array;
    /** Client-side deadline. Never omitted: no Nest call may wait forever. */
    timeoutMs: number;
    /** Caller-owned abort, used for shutdown. Distinct from the timeout. */
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}
/** A completed HTTP exchange, before any status interpretation. */
export interface RawResponse {
    readonly status: number;
    readonly headers: Headers;
    readonly text: string;
}
/**
 * Perform an HTTP request with a client-side deadline.
 *
 * @throws {TimeoutError} When {@link SendOptions.timeoutMs} elapsed first.
 * @throws {NetworkError} On transport failure.
 * @throws The caller's abort error unchanged when {@link SendOptions.signal}
 *   fired, so a shutdown is never mistaken for a timeout.
 */
export declare function sendRequest(url: string, options: SendOptions): Promise<RawResponse>;
/**
 * Perform a request and parse a JSON response.
 *
 * The status is checked first, but the body is not discarded: it is excerpted
 * into the error, because Nest puts its most useful diagnostics there.
 *
 * @throws {ApiParseError} When the body is not JSON. Nest serves an HTML error
 *   page from its edge when a request is refused before it reaches the API,
 *   and reporting that as a JSON syntax error hides what happened.
 */
export declare function requestJson<T>(url: string, options: SendOptions): Promise<T>;
//# sourceMappingURL=http.d.ts.map