/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Building thermostat state from Observe traits and REST buckets.
 *
 * Observe is authoritative here. On an account whose thermostats have moved to
 * the protobuf backend — which is now the common case — REST reports no
 * thermostat buckets at all while still claiming the home has five of them.
 * The REST path below exists for older accounts that do return them.
 */
import type { ThermostatState } from '../types/device';
import type { SharedBucket, DeviceBucket } from '../types/nest';
import type { ObserveState } from './observe-state';
/** Where a thermostat is currently reading its temperature from. */
export interface ComfortSource {
    /** Observe resource id of the remote sensor, when one is in control. */
    readonly sensorResourceId?: string;
}
/**
 * Which sensor the thermostat is regulating to.
 *
 * A Nest thermostat paired with Temperature Sensors regulates to the selected
 * sensor, and the Nest app shows that sensor's reading as the current
 * temperature. Publishing the thermostat's own backplate reading instead makes
 * the Home app disagree with the Nest app by several degrees, which reads as a
 * bug even though both numbers are real.
 */
export declare function readComfortSource(state: ObserveState, resourceId: string): ComfortSource;
/** Build thermostat state from the Observe stream. */
export declare function readThermostatFromObserve(state: ObserveState, resourceId: string, options?: {
    comfortTemperatureC?: number;
}): ThermostatState;
/**
 * Build thermostat state from the legacy REST buckets.
 *
 * Used only for accounts that still report `device` and `shared` buckets. The
 * shapes are simpler here because REST already flattens Nest's indirection.
 */
export declare function readThermostatFromRest(shared: SharedBucket | undefined, device: DeviceBucket | undefined): ThermostatState;
/**
 * Combine both transports, letting whichever reported a field win.
 *
 * Observe takes precedence because it is the live push channel; REST fills
 * gaps rather than overriding. Merging field by field rather than picking one
 * source means a home with a mix of old and new thermostats works without a
 * special case.
 */
export declare function mergeThermostatState(observe: ThermostatState | undefined, rest: ThermostatState | undefined): ThermostatState;
