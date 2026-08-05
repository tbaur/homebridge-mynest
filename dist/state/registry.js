"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The union of what both transports report about the home.
 *
 * Neither Nest API is a superset of the other. On the account this plugin was
 * built against, REST `app_launch` returned six Protects and no thermostats
 * while the Observe stream returned seven Protects and five thermostats — and
 * REST simultaneously claimed `num_thermostats: "5+"`. Trusting either alone
 * loses devices, so the registry unions them and records which one supplied
 * each device.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildInventory = buildInventory;
exports.listDevices = listDevices;
const classify_1 = require("./classify");
const protect_state_1 = require("./protect-state");
const sensor_state_1 = require("./sensor-state");
const thermostat_state_1 = require("./thermostat-state");
const traits_1 = require("./traits");
/** REST bucket types that identify a device, mapped to what they are. */
const REST_DEVICE_BUCKETS = [
    { bucket: 'topaz', kind: 'protect' },
    { bucket: 'kryptonite', kind: 'temperature_sensor' },
    { bucket: 'shared', kind: 'thermostat' },
    { bucket: 'device', kind: 'thermostat' },
];
/**
 * Merge both transports into the device list the platform publishes.
 *
 * Pure: it reads the two state stores and returns a new inventory, so it can
 * be exercised against fixtures without any transport.
 */
function buildInventory(options) {
    const { observe, buckets, ignoredDeviceIds, restAlarmFeedAvailable = true, } = options;
    const kinds = collectDeviceKinds(observe, buckets);
    const roomNames = mergeRoomNames((0, classify_1.collectObserveRoomNames)(observe), readRestRoomNames(buckets));
    const comfortTemperatures = readComfortTemperatures(observe, buckets, kinds);
    const thermostats = new Map();
    const protects = new Map();
    const sensors = new Map();
    for (const [deviceId, kind] of kinds) {
        const context = { observe, buckets, deviceId, roomNames, restAlarmFeedAvailable };
        let device;
        switch (kind) {
            case 'thermostat':
                device = buildThermostat(context, comfortTemperatures.get(deviceId));
                break;
            case 'protect':
                device = buildProtect(context);
                break;
            case 'temperature_sensor':
                device = buildTemperatureSensor(context);
                break;
        }
        // Match against both the inventory id and the Nest serial (docs promise
        // either). Serial usually equals the id but can differ when Observe's
        // device_identity trait disagrees with the REST bucket key.
        const serial = device.identity.serialNumber?.toUpperCase();
        if (ignoredDeviceIds.has(deviceId.toUpperCase())
            || (serial !== undefined && ignoredDeviceIds.has(serial))) {
            continue;
        }
        switch (kind) {
            case 'thermostat':
                thermostats.set(deviceId, device);
                break;
            case 'protect':
                protects.set(deviceId, device);
                break;
            case 'temperature_sensor':
                sensors.set(deviceId, device);
                break;
        }
    }
    return { thermostats, protects, temperatureSensors: sensors };
}
/**
 * Enumerate every device either transport knows about.
 *
 * A device present on both is listed once, because Observe's `DEVICE_<id>` and
 * the REST bucket id are the same hardware id with a prefix.
 */
function collectDeviceKinds(observe, buckets) {
    const kinds = new Map();
    for (const resourceId of observe.resourceIds) {
        const kind = (0, classify_1.classifyResource)(resourceId, observe.typeUrls(resourceId));
        if (kind) {
            kinds.set((0, classify_1.toDeviceId)(resourceId), kind);
        }
    }
    for (const { bucket, kind } of REST_DEVICE_BUCKETS) {
        for (const id of Object.keys(buckets[bucket] ?? {})) {
            // Observe classification wins: it sees the device's real trait set,
            // whereas the REST bucket name is only a hint about what it should be.
            if (!kinds.has(id)) {
                kinds.set(id, kind);
            }
        }
    }
    return kinds;
}
/** Room names from the REST `where` buckets, keyed by Nest's `where_id`. */
function readRestRoomNames(buckets) {
    const names = new Map();
    for (const value of Object.values(buckets.where ?? {})) {
        for (const entry of value?.wheres ?? []) {
            // Type-checked, not just truthiness-checked: a non-string name here ends
            // up in `resolveDeviceName`, where `.trim()` throws.
            const whereId = (0, traits_1.readString)(entry, 'where_id');
            const name = (0, traits_1.readString)(entry, 'name');
            if (whereId && name) {
                names.set(whereId, name);
            }
        }
    }
    return names;
}
/** Combine both room-name tables; the id namespaces do not overlap. */
function mergeRoomNames(observe, rest) {
    return new Map([...rest, ...observe]);
}
/**
 * Resolve the temperature each thermostat is actually regulating to.
 *
 * Computed up front because it crosses devices: a thermostat's reading may
 * belong to a Temperature Sensor elsewhere in the inventory.
 */
function readComfortTemperatures(observe, buckets, kinds) {
    const temperatures = new Map();
    for (const [deviceId, kind] of kinds) {
        if (kind !== 'thermostat') {
            continue;
        }
        const { sensorResourceId } = (0, thermostat_state_1.readComfortSource)(observe, (0, classify_1.toResourceId)(deviceId));
        if (!sensorResourceId) {
            continue;
        }
        const sensor = (0, sensor_state_1.readTemperatureSensorState)({
            state: observe,
            resourceId: sensorResourceId,
            // The same REST fallback `buildTemperatureSensor` gives this device on its
            // own tile. Omitting it meant a sensor whose reading currently only exists
            // in the kryptonite bucket — an Observe patch not yet redelivered after a
            // reconnect — silently dropped the thermostat back to its own backplate,
            // which is the several-degree disagreement with the Nest app that this
            // whole feature exists to remove.
            kryptonite: buckets.kryptonite?.[(0, classify_1.toDeviceId)(sensorResourceId)],
        });
        if (sensor.temperatureC !== undefined) {
            temperatures.set(deviceId, sensor.temperatureC);
        }
    }
    return temperatures;
}
/** Identity fields common to every device, from whichever transport has them. */
function buildIdentity(context, kind) {
    const { observe, buckets, deviceId, roomNames } = context;
    const resourceId = (0, classify_1.toResourceId)(deviceId);
    const identityTrait = observe.trait(resourceId, 'device_identity');
    const restBucket = findRestBucket(buckets, deviceId);
    // Every REST-sourced string goes through `readString`. These are raw JSON
    // values that TypeScript only *claims* are strings; a number or object
    // reaching `resolveDeviceName` throws on `.trim()`, and that throw escapes
    // `buildInventory` on every update cycle, so the plugin publishes nothing at
    // all until Nest changes its mind.
    const whereId = (0, traits_1.readString)(observe.trait(resourceId, 'device_located_settings'), 'whereId', 'value')
        ?? (0, traits_1.readString)(restBucket, 'where_id');
    const sources = {
        observe: observe.resource(resourceId) !== undefined,
        rest: restBucket !== undefined,
    };
    return {
        id: deviceId,
        kind,
        name: (0, classify_1.resolveDeviceName)({
            kind,
            deviceId,
            label: (0, traits_1.readString)(observe.trait(resourceId, 'label'), 'label'),
            description: (0, traits_1.readString)(restBucket, 'description') ?? (0, traits_1.readString)(restBucket, 'name'),
            roomName: whereId ? roomNames.get(whereId) : undefined,
        }),
        sources,
        // `topaz` spells the model `model`; `device` spells it `model_version`.
        model: (0, traits_1.readString)(identityTrait, 'modelName', 'value')
            ?? (0, traits_1.readString)(restBucket, 'model')
            ?? (0, traits_1.readString)(restBucket, 'model_version'),
        serialNumber: (0, traits_1.readString)(identityTrait, 'serialNumber')
            ?? (0, traits_1.readString)(restBucket, 'serial_number')
            ?? deviceId,
        firmwareVersion: (0, traits_1.readString)(identityTrait, 'fwVersion'),
        whereId,
        structureId: (0, traits_1.readString)(restBucket, 'structure_id'),
    };
}
/**
 * Every REST bucket carrying this id, merged into one identity view.
 *
 * A legacy thermostat appears in both `shared` and `device`, and the two carry
 * different halves of its identity: `shared` has only the setpoints and a name,
 * while `where_id`, `serial_number`, `structure_id`, and the model live in
 * `device`. Taking the first match would silently drop the room assignment, so
 * the device would be published as "Thermostat ABCD" instead of "Hallway
 * Thermostat". Earlier buckets win on conflict, matching the previous
 * first-match precedence.
 */
function findRestBucket(buckets, deviceId) {
    let merged;
    for (const { bucket } of REST_DEVICE_BUCKETS) {
        const value = buckets[bucket]?.[deviceId];
        if (value && typeof value === 'object') {
            merged = { ...value, ...merged };
        }
    }
    return merged;
}
function buildThermostat(context, comfortTemperatureC) {
    const { observe, buckets, deviceId } = context;
    const resourceId = (0, classify_1.toResourceId)(deviceId);
    const fromObserve = observe.resource(resourceId)
        ? (0, thermostat_state_1.readThermostatFromObserve)(observe, resourceId, { comfortTemperatureC })
        : undefined;
    const fromRest = (0, thermostat_state_1.readThermostatFromRest)(buckets.shared?.[deviceId], buckets.device?.[deviceId]);
    return {
        identity: buildIdentity(context, 'thermostat'),
        state: (0, thermostat_state_1.mergeThermostatState)(fromObserve, fromRest),
    };
}
function buildProtect(context) {
    const { observe, buckets, deviceId, restAlarmFeedAvailable } = context;
    return {
        identity: buildIdentity(context, 'protect'),
        state: (0, protect_state_1.readProtectState)({
            state: observe,
            resourceId: (0, classify_1.toResourceId)(deviceId),
            topaz: buckets.topaz?.[deviceId],
            restAlarmFeedAvailable,
        }),
    };
}
function buildTemperatureSensor(context) {
    const { observe, buckets, deviceId } = context;
    return {
        identity: buildIdentity(context, 'temperature_sensor'),
        state: (0, sensor_state_1.readTemperatureSensorState)({
            state: observe,
            resourceId: (0, classify_1.toResourceId)(deviceId),
            kryptonite: buckets.kryptonite?.[deviceId],
        }),
    };
}
/** Every device in an inventory, in a stable order, for logging and iteration. */
function listDevices(inventory) {
    return [
        ...inventory.thermostats.values(),
        ...inventory.protects.values(),
        ...inventory.temperatureSensors.values(),
    ];
}
