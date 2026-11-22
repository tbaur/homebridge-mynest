"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileCookieStore = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const settings_1 = require("../settings");
/** Fixed salt for the configured-cookies fingerprint. Not a credential. */
const FINGERPRINT_SALT = 'homebridge-mynest:cookie-source';
function fingerprint(configuredCookies) {
    return (0, node_crypto_1.scryptSync)(configuredCookies, FINGERPRINT_SALT, 16).toString('hex');
}
function isSavedCookies(value) {
    return typeof value === 'object'
        && value !== null
        && 'source' in value
        && typeof value.source === 'string'
        && 'cookies' in value
        && typeof value.cookies === 'string';
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
function isMissingFile(error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
/** A {@link CookieStore} backed by one owner-only file in the Homebridge storage path. */
class FileCookieStore {
    #dir;
    #file;
    #log;
    #hasWarned = false;
    constructor(storagePath, log) {
        this.#dir = (0, node_path_1.join)(storagePath, settings_1.STATE_DIR);
        this.#file = (0, node_path_1.join)(this.#dir, settings_1.COOKIE_STATE_FILE);
        this.#log = log;
    }
    load(configuredCookies) {
        let text;
        try {
            text = (0, node_fs_1.readFileSync)(this.#file, 'utf8');
        }
        catch (error) {
            if (!isMissingFile(error)) {
                this.#log.debug(`Saved Google cookies could not be read; using the configured ones (${describe(error)})`);
            }
            return undefined;
        }
        let saved;
        try {
            saved = JSON.parse(text);
        }
        catch {
            this.#log.debug('Saved Google cookies are not valid JSON; using the configured ones');
            return undefined;
        }
        if (!isSavedCookies(saved) || saved.source !== fingerprint(configuredCookies) || saved.cookies === '') {
            return undefined;
        }
        return saved.cookies;
    }
    save(configuredCookies, cookies) {
        const saved = { source: fingerprint(configuredCookies), cookies };
        const temp = `${this.#file}.tmp`;
        try {
            (0, node_fs_1.mkdirSync)(this.#dir, { recursive: true, mode: 0o700 });
            (0, node_fs_1.writeFileSync)(temp, JSON.stringify(saved), { mode: 0o600 });
            (0, node_fs_1.chmodSync)(temp, 0o600);
            (0, node_fs_1.renameSync)(temp, this.#file);
            this.#hasWarned = false;
        }
        catch (error) {
            if (!this.#hasWarned) {
                this.#hasWarned = true;
                this.#log.warn(`Could not save updated Google cookies (${describe(error)}); sign-in keeps working until Homebridge restarts`);
            }
        }
    }
}
exports.FileCookieStore = FileCookieStore;
