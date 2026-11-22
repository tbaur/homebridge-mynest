/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Keeps the Google cookies that sign-in updates across restarts.
 *
 * The saved cookies are tied to the cookies in the configuration by a
 * fingerprint. Pasting new cookies into the config therefore replaces the
 * saved ones instead of being overridden by them.
 */
import type { Logger } from '../utils/logger';
import type { CookieStore } from './google-auth';
/** A {@link CookieStore} backed by one owner-only file in the Homebridge storage path. */
export declare class FileCookieStore implements CookieStore {
    #private;
    constructor(storagePath: string, log: Logger);
    load(configuredCookies: string): string | undefined;
    save(configuredCookies: string, cookies: string): void;
}
