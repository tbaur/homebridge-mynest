/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Safe readers for decoded Nest trait objects.
 *
 * Nest wraps nearly every scalar in a single-field message, so a temperature
 * arrives as `{ temperature: { value: { value: 21.8 } } }`. Worse, proto3 omits
 * fields at their default, so a reading of exactly zero and a reading that was
 * never sent are indistinguishable in the decoded object — both are `{}`.
 *
 * These readers therefore return `undefined` for anything they cannot confirm,
 * and callers treat `undefined` as "leave HomeKit alone" rather than
 * substituting a default. The alternative is a thermostat that reads 0 °C
 * whenever Nest omits a field.
 */
/** Read a finite number at a nested path. */
export declare function readNumber(source: unknown, ...path: readonly string[]): number | undefined;
/** Read a non-empty string at a nested path. */
export declare function readString(source: unknown, ...path: readonly string[]): string | undefined;
/**
 * Read a flag that Nest encodes as an int32 rather than a bool.
 *
 * Present-and-nonzero is true; absent is `undefined`, not false. A capability
 * flag that is missing means "Nest did not say", and reporting that as "cannot
 * heat" would hide the heating controls on a thermostat that has them.
 */
export declare function readIntFlag(source: unknown, ...path: readonly string[]): boolean | undefined;
export declare function readIndirectFloat(source: unknown, ...path: readonly string[]): number | undefined;
/**
 * Read a Nest temperature trait, in Celsius.
 *
 * The shape is `TemperatureTrait.temperature.value.value` — a message wrapping
 * a message wrapping the float. Nest reports Celsius on the wire regardless of
 * what the device displays.
 */
export declare function readTemperatureC(trait: unknown): number | undefined;
/** Read a Nest humidity trait, as a percentage. */
export declare function readHumidity(trait: unknown): number | undefined;
/**
 * Reject readings outside what a habitable building can produce.
 *
 * Guards against a decode landing on the wrong field and against HomeKit
 * refusing a characteristic write that falls outside its permitted range,
 * which throws rather than clamping.
 */
export declare function isPlausibleTemperature(celsius: number): boolean;
/** An enum protobufjs rendered as its symbolic name. */
export declare function readEnum(source: unknown, ...path: readonly string[]): string | undefined;
//# sourceMappingURL=traits.d.ts.map