/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * Both sign-in values are copied by hand from a browser's developer tools, so
 * the checks here are shaped by the mistakes that copy makes: the wrong
 * request's URL, a header name pasted along with its value, or a truncated
 * value. Each otherwise fails at runtime as an unexplained Google error.
 *
 * Log copy uses the Homebridge UI titles (Title Case), not JSON keys.
 */
import type { ConfigValidationResult, MyNestPlatformConfig } from '../types/config';
/**
 * Validate and normalise the user's platform configuration.
 *
 * @throws {ConfigurationError} When a required value is missing or unusable.
 */
export declare function validateConfig(raw: MyNestPlatformConfig): ConfigValidationResult;
