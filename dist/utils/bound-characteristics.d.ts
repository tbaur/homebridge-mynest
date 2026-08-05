/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Characteristic binding that pushes live values under HAP 2.
 *
 * This solves a specific, load-bearing problem. Under HAP 1 a plugin could push
 * a fresh reading by calling `characteristic.getValue()`, which re-ran the
 * registered `onGet` handler and notified subscribers with the result. HAP 2
 * removed `getValue()`, and the two obvious repairs are both wrong:
 *
 *   - Keep calling `getValue()`. The plugin throws on Homebridge 2 at boot.
 *   - Call `updateValue(characteristic.value)`. It boots, but `.value` is the
 *     *cached* value, so every push writes back what HomeKit already had. The
 *     process looks healthy and no reading ever changes again.
 *
 * The community Nest plugin shipped each of those in turn (4.6.9 and 4.6.10).
 * The fix is to keep the read function next to the characteristic, so a push
 * can recompute from current device state and hand the result to
 * `updateValue`. That is what {@link CharacteristicBinder} stores.
 */
import type { Characteristic, CharacteristicValue, Service, WithUUID } from 'homebridge';
import type { Logger } from './logger';
/** Computes a characteristic's current value from device state. */
export type CharacteristicReader = () => CharacteristicValue | null | undefined;
/** Applies a HomeKit-originated write to the device. */
export type CharacteristicWriter = (value: CharacteristicValue) => Promise<void>;
type CharacteristicType = WithUUID<new () => Characteristic>;
/**
 * Holds every characteristic an accessory publishes, with how to read it.
 *
 * Accessories bind once at construction and call {@link refresh} whenever new
 * device state arrives; they never push values characteristic by characteristic.
 */
export declare class CharacteristicBinder {
    #private;
    /**
     * @param label Device name written into failure messages. `createScopedLogger`
     *   deliberately does not prefix lines, so without it
     *   `Could not compute Smoke Detected` names no device — unactionable in a
     *   house with a dozen Protects.
     */
    constructor(log: Logger, label?: string);
    /**
     * Publish a characteristic and record how to compute its value.
     *
     * The `onGet` handler is registered from the same reader, so a direct HomeKit
     * read and a plugin-initiated push can never disagree.
     *
     * @param options.write When present, makes the characteristic writable and
     *   routes HomeKit writes to the device.
     */
    bind(service: Service, type: CharacteristicType, read: CharacteristicReader, options?: {
        write?: CharacteristicWriter;
    }): Characteristic;
    /**
     * Drop every binding that belongs to a service about to be removed.
     *
     * Without this, `refresh` would keep calling `updateValue` on characteristics
     * whose service is gone from the accessory.
     */
    unbindService(service: Service): void;
    /**
     * Recompute and push every bound characteristic.
     *
     * Readers returning `null`/`undefined` are skipped rather than written as a
     * default. A Nest device that has not reported a trait yet must keep its last
     * known value in HomeKit; substituting `0` would show a thermostat reading
     * 0 °C or a smoke alarm reporting all-clear on no evidence.
     *
     * A throwing reader is logged and skipped so one bad mapping cannot stop the
     * rest of the accessory from updating.
     */
    refresh(): void;
    /** Number of bound characteristics. Exposed for tests and diagnostics. */
    get size(): number;
}
export {};
//# sourceMappingURL=bound-characteristics.d.ts.map