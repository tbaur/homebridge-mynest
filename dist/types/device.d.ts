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
/** The device classes this plugin publishes to HomeKit. */
export type DeviceKind = 'thermostat' | 'protect' | 'temperature_sensor';
/** Which transports contributed to a device's state. */
export interface DeviceSources {
    readonly observe: boolean;
    readonly rest: boolean;
}
/** Stable identity for one physical Nest device. */
export interface DeviceIdentity {
    /**
     * Stable key used to derive the HomeKit accessory UUID.
     *
     * Always the bare hardware id with no transport prefix, so a device that
     * appears on Observe first and REST later — or that stops being reported by
     * one of them — keeps the same HomeKit accessory instead of being republished
     * as a new one.
     */
    readonly id: string;
    readonly kind: DeviceKind;
    readonly name: string;
    readonly sources: DeviceSources;
    readonly model?: string;
    readonly serialNumber?: string;
    readonly firmwareVersion?: string;
    /** Nest's room assignment id, resolved to {@link DeviceIdentity.name}. */
    readonly whereId?: string;
    readonly structureId?: string;
}
/** Thermostat modes, using Nest's own vocabulary. */
export type HvacMode = 'off' | 'heat' | 'cool' | 'range';
/** What the equipment is doing right now. */
export type HvacActivity = 'idle' | 'heating' | 'cooling';
export interface ThermostatState {
    readonly currentTemperatureC?: number;
    readonly currentHumidity?: number;
    readonly mode?: HvacMode;
    /**
     * Nest's `settings.hvacMode` even while the unit is off (`active=0`).
     * Nest never stores OFF there — HomeKit `off` clears `active` and leaves
     * this mode in place for the next wake.
     */
    readonly lastHvacMode?: Exclude<HvacMode, 'off'>;
    readonly activity?: HvacActivity;
    /** Single setpoint, used in `heat` and `cool` modes. */
    readonly targetTemperatureC?: number;
    /** Lower bound of the `range` setpoint pair. */
    readonly targetTemperatureLowC?: number;
    /** Upper bound of the `range` setpoint pair. */
    readonly targetTemperatureHighC?: number;
    readonly isEcoActive?: boolean;
    readonly canHeat?: boolean;
    readonly canCool?: boolean;
    /** The unit shown on the device itself; HomeKit is always told Celsius. */
    readonly displayUnit?: 'C' | 'F';
}
/** Nest's three-level alarm scale, shared by the smoke and CO sensors. */
export type AlarmLevel = 'ok' | 'warning' | 'emergency';
/**
 * Why occupancy is or is not available for a Protect.
 *
 * Recorded so the plugin can tell the user the truth. A Protect has a PIR
 * sensor but does not publish motion events on either API; all that is
 * available is Nest's own `auto_away` verdict, which flips only after about
 * ten minutes of no activity and only on mains-powered units.
 */
export type OccupancySource = 
/** Derived from REST `topaz.auto_away`. Ten-minute resolution, not motion. */
'auto_away'
/** Device is battery-powered; Nest does not compute occupancy for it. */
 | 'unsupported_battery_powered'
/** Device is only visible on Observe, which carries no occupancy state. */
 | 'unavailable_observe_only'
/** REST lists the Protect but omitted `auto_away` (no occupancy to publish). */
 | 'unavailable_no_auto_away'
/** REST listed the Protect but neither transport confirmed mains power. */
 | 'unavailable_power_unknown'
/**
 * REST previously reported this Protect, but the REST feed is no longer
 * trustworthy (breaker open, forbidden-dead, or stale). Last-known
 * alarm/occupancy stay published and are marked inactive/faulted.
 */
 | 'unavailable_rest_stale';
export interface ProtectState {
    readonly smoke?: AlarmLevel;
    readonly carbonMonoxide?: AlarmLevel;
    /**
     * True when smoke/CO (and REST occupancy) are last-known values because the
     * REST feed cannot refresh them. Accessories stay published and are marked
     * inactive/faulted — they are not removed, so HomeKit room placement and
     * automations targeting those services survive Nest outages.
     */
    readonly isAlarmFeedStale?: boolean;
    readonly isBatteryLow?: boolean;
    /**
     * Battery pack voltage.
     *
     * Deliberately not a percentage. REST reports this as `battery_level`, which
     * on a Protect is millivolts — a Protect with a healthy pack reads about
     * 5226. Publishing that number as the percentage the field name implies puts
     * "5226%" in front of the user, and converting it honestly would need a
     * discharge curve for a pack Nest does not document.
     */
    readonly batteryVolts?: number;
    readonly isOnline?: boolean;
    readonly isLinePowered?: boolean;
    /** `true` means occupied. `undefined` when Nest reports no verdict at all. */
    readonly isOccupied?: boolean;
    readonly occupancySource: OccupancySource;
    readonly temperatureC?: number;
    readonly humidity?: number;
}
export interface TemperatureSensorState {
    readonly temperatureC?: number;
    /** Percent, when Nest reports one. */
    readonly batteryLevel?: number;
    readonly isBatteryLow?: boolean;
}
/** One device, discriminated by {@link DeviceKind}. */
export type NestDevice = {
    readonly identity: DeviceIdentity & {
        kind: 'thermostat';
    };
    readonly state: ThermostatState;
} | {
    readonly identity: DeviceIdentity & {
        kind: 'protect';
    };
    readonly state: ProtectState;
} | {
    readonly identity: DeviceIdentity & {
        kind: 'temperature_sensor';
    };
    readonly state: TemperatureSensorState;
};
/** One device of a specific kind, with the matching state type. */
export type DeviceOfKind<K extends DeviceKind> = Extract<NestDevice, {
    identity: {
        kind: K;
    };
}>;
/**
 * Narrow a device to one kind.
 *
 * `NestDevice` is discriminated by `identity.kind`, and TypeScript only narrows
 * on a discriminant at the top level of a union member — so a `switch` on the
 * nested property compiles but leaves the device untyped. These guards do the
 * narrowing explicitly rather than pushing casts out to every call site.
 */
export declare function isDeviceOfKind<K extends DeviceKind>(device: NestDevice, kind: K): device is DeviceOfKind<K>;
/** The whole home, as the platform sees it after merging both transports. */
export interface DeviceInventory {
    readonly thermostats: ReadonlyMap<string, Extract<NestDevice, {
        identity: {
            kind: 'thermostat';
        };
    }>>;
    readonly protects: ReadonlyMap<string, Extract<NestDevice, {
        identity: {
            kind: 'protect';
        };
    }>>;
    readonly temperatureSensors: ReadonlyMap<string, Extract<NestDevice, {
        identity: {
            kind: 'temperature_sensor';
        };
    }>>;
}
