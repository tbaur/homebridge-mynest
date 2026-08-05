"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Working out what a Nest resource is and what to call it.
 *
 * Nest's Observe stream never states a device's type. It streams whatever
 * traits the hardware supports, so the type has to be inferred from which
 * traits are present. That is less fragile than it sounds: a Protect is the
 * only thing that carries `nest.trait.product.protect.*`, and a thermostat the
 * only thing that carries `hvac.HvacControlTrait`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OBSERVE_DEVICE_PREFIX = void 0;
exports.toDeviceId = toDeviceId;
exports.toResourceId = toResourceId;
exports.classifyResource = classifyResource;
exports.collectObserveRoomNames = collectObserveRoomNames;
exports.resolveDeviceName = resolveDeviceName;
const traits_1 = require("./traits");
/** Prefix Nest puts on every device resource id on the Observe stream. */
exports.OBSERVE_DEVICE_PREFIX = 'DEVICE_';
/**
 * Reduce an Observe resource id to the id the REST buckets use.
 *
 * Confirmed on a live account: Observe reports `DEVICE_18B4300000ACC1AD` for
 * the same Protect that REST reports as `topaz.18B4300000ACC1AD`. This exact
 * correspondence is what makes merging the two transports possible at all.
 */
function toDeviceId(resourceId) {
    return resourceId.startsWith(exports.OBSERVE_DEVICE_PREFIX)
        ? resourceId.slice(exports.OBSERVE_DEVICE_PREFIX.length)
        : resourceId;
}
/** Expand a REST bucket id into the Observe resource id for the same device. */
function toResourceId(deviceId) {
    return deviceId.startsWith(exports.OBSERVE_DEVICE_PREFIX)
        ? deviceId
        : `${exports.OBSERVE_DEVICE_PREFIX}${deviceId}`;
}
/**
 * Identify a device from the protobuf types it reports.
 *
 * Order matters. A Protect carries `sensor.TemperatureTrait` too, so the
 * temperature-sensor test has to come after the Protect and thermostat tests
 * or every Protect in the house is published as a thermometer.
 */
function classifyResource(resourceId, typeUrls) {
    if (!resourceId.startsWith(exports.OBSERVE_DEVICE_PREFIX)) {
        return undefined;
    }
    const joined = typeUrls.join(' ');
    if (joined.includes('nest.trait.product.protect.')) {
        return 'protect';
    }
    if (joined.includes('nest.trait.hvac.HvacControlTrait')) {
        return 'thermostat';
    }
    if (joined.includes('nest.trait.sensor.TemperatureTrait')) {
        return 'temperature_sensor';
    }
    return undefined;
}
/**
 * Collect every room name the Observe stream has reported.
 *
 * The annotation list is duplicated onto the structure and onto each
 * thermostat, so it is gathered from every resource that carries it rather
 * than from one assumed location.
 */
function collectObserveRoomNames(state) {
    const names = new Map();
    for (const resourceId of state.resourceIds) {
        const annotations = state.trait(resourceId, 'located_annotations');
        if (!annotations) {
            continue;
        }
        for (const group of ['annotations', 'customAnnotations', 'custom_annotations']) {
            const entries = annotations[group];
            if (!Array.isArray(entries)) {
                continue;
            }
            for (const entry of entries) {
                const id = (0, traits_1.readString)(entry, 'info', 'id', 'value');
                const name = (0, traits_1.readString)(entry, 'info', 'name', 'value');
                if (id && name) {
                    names.set(id, name);
                }
            }
        }
    }
    return names;
}
/** Longest device name published to HomeKit, before the kind suffix. */
const MAX_DEVICE_NAME_LENGTH = 64;
/**
 * Make a Nest-supplied name safe to publish and to log.
 *
 * Names come from the Nest `label` trait or a REST `description`, so they are
 * remote input. Control characters are stripped because Homebridge logs are the
 * primary support artifact and get pasted into public issue trackers — a device
 * named with an embedded newline can forge log lines. The value is also
 * type-checked rather than trusted: TypeScript only claims these are strings.
 */
function cleanName(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length > 0 ? cleaned.slice(0, MAX_DEVICE_NAME_LENGTH) : undefined;
}
/**
 * Choose the name to publish to HomeKit.
 *
 * Preference order is deliberate: a name the user typed beats a room name, and
 * a room name beats anything derived from an id. The final fallback includes
 * the tail of the hardware id so two unnamed devices of the same kind are
 * still distinguishable in the Home app.
 */
function resolveDeviceName(options) {
    const explicit = cleanName(options.label) ?? cleanName(options.description);
    if (explicit) {
        return explicit;
    }
    const room = cleanName(options.roomName);
    if (room) {
        return `${room} ${KIND_LABELS[options.kind]}`;
    }
    return `${KIND_LABELS[options.kind]} ${options.deviceId.slice(-4).toUpperCase()}`;
}
const KIND_LABELS = {
    thermostat: 'Thermostat',
    protect: 'Protect',
    temperature_sensor: 'Temperature Sensor',
};
