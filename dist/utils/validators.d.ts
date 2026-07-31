/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * The checks here are shaped by what users actually paste into this field.
 * `access_token` sits in a JSON blob next to half a dozen other tokens, and
 * getting the wrong one produces an opaque HTTP 401 at runtime with nothing
 * pointing back at the config. Catching the recognisable mistakes at startup
 * is worth more than a generic "required field" error.
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
//# sourceMappingURL=validators.d.ts.map