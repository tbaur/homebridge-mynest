"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The device model the accessories read, merged from both
 * transports.
 *
 * Nest exposes the same home through two APIs that disagree about what is in
 * it. On the account this plugin was built against, REST `app_launch` reported
 * six Protects and zero thermostats while the Observe stream reported seven
 * Protects and five thermostats. Neither is a superset of the other, so the
 * model below is deliberately transport-agnostic: it records what is known and
 * which transport said so, and leaves anything unreported as `undefined`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDeviceOfKind = isDeviceOfKind;
/**
 * Narrow a device to one kind.
 *
 * `NestDevice` is discriminated by `identity.kind`, and TypeScript only narrows
 * on a discriminant at the top level of a union member — so a `switch` on the
 * nested property compiles but leaves the device untyped. These guards do the
 * narrowing explicitly rather than pushing casts out to every call site.
 */
function isDeviceOfKind(device, kind) {
    return device.identity.kind === kind;
}
