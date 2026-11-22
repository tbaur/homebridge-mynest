/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Google account sign-in, producing Nest tokens on demand.
 *
 * Flow, repeated before each token expires:
 *   1. `GET` the configured issueToken URL with the account's Google cookies.
 *      Google answers with a short-lived OAuth access token.
 *   2. `POST` that token to Nest's auth proxy (`issue_jwt`), which answers with
 *      a Nest token and its expiry.
 *   3. The caller opens a Nest session with the Nest token (see `session.ts`).
 *
 * Google refreshes some of its cookies on every sign-in, the same way it does
 * in a browser. Those are merged back in and handed to a {@link CookieStore},
 * so the next sign-in, including the first one after a restart, presents what
 * Google last issued.
 */
import type { Logger } from '../utils/logger';
import { type FetchLike } from './http';
/** A Nest token and when it stops working. */
export interface NestToken {
    readonly value: string;
    /** Epoch milliseconds. */
    readonly expiresAt: number;
}
/** Anything that can produce a fresh Nest token. */
export interface TokenSource {
    mintToken(signal?: AbortSignal): Promise<NestToken>;
}
/** Where cookies that Google updates are kept between restarts. */
export interface CookieStore {
    /** The cookie header last saved for these configured cookies, if any. */
    load(configuredCookies: string): string | undefined;
    save(configuredCookies: string, cookies: string): void;
}
export interface GoogleAuthOptions {
    /** Validated issueToken URL (see `validators.ts`). */
    issueToken: string;
    /** Validated `Cookie` header from the configuration. */
    cookies: string;
    store?: CookieStore;
    log: Logger;
    fetchImpl?: FetchLike;
}
/**
 * Parse a `Cookie` header into an ordered name → value map.
 *
 * Order is kept so a merged header reads the same as the browser's did.
 */
export declare function parseCookieHeader(header: string): Map<string, string>;
/** Serialise a cookie map back into a `Cookie` header. */
export declare function formatCookieHeader(jar: ReadonlyMap<string, string>): string;
/**
 * Apply `Set-Cookie` headers to a cookie header.
 *
 * A cookie whose value is empty, whose `Max-Age` is zero or less, or whose
 * `Expires` is in the past is removed, which is how a server deletes one.
 *
 * @returns The merged header, or the input unchanged when nothing applied.
 */
export declare function mergeSetCookies(header: string, setCookies: readonly string[], now?: number): string;
/** Signs in to the Google account and exchanges the result for Nest tokens. */
export declare class GoogleAuth implements TokenSource {
    #private;
    constructor(options: GoogleAuthOptions);
    /**
     * Sign in and return a fresh Nest token.
     *
     * @throws {AuthenticationError} When Google rejects the cookies or Nest
     *   rejects the Google token. Signing in again would be refused too.
     */
    mintToken(signal?: AbortSignal): Promise<NestToken>;
}
