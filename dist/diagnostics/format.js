"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Human-readable formatting for diagnostics reports.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDiagnosticLine = formatDiagnosticLine;
/** Human-readable label for a diagnostics channel. */
function diagnosticLabel(msg) {
    switch (msg) {
        case 'health':
            return 'Health';
        case 'diagnostics.start':
            return 'Diagnostics start';
        case 'diagnostics.stop':
            return 'Diagnostics stop';
        case 'health.degraded':
            return 'Health degraded';
        case 'health.recovered':
            return 'Health recovered';
        default:
            return msg;
    }
}
/** Concise human-readable summary line for a diagnostics report. */
function formatDiagnosticLine(report) {
    const { lifecycle, devices, transport, api, circuitBreaker } = report;
    const reasonText = lifecycle.reasons.length > 0 ? ` [${lifecycle.reasons.join(', ')}]` : '';
    const kindText = [
        `${devices.byKind.thermostat}T`,
        `${devices.byKind.protect}P`,
        `${devices.byKind.temperature_sensor}S`,
    ].join('/');
    const breakerParts = [];
    if (circuitBreaker.rest.state !== 'CLOSED') {
        breakerParts.push(`rest=${circuitBreaker.rest.state}`);
    }
    if (circuitBreaker.observe.state !== 'CLOSED') {
        breakerParts.push(`obs=${circuitBreaker.observe.state}`);
    }
    const breakerText = breakerParts.length > 0 ? ` | breaker ${breakerParts.join(' ')}` : '';
    return (`${diagnosticLabel(report.msg)}: ${lifecycle.health}${reasonText} | `
        + `devices ${devices.total} (${kindText}) | `
        + `obs ${transport.observeState} rest ${transport.restState}`
        + `${breakerText} | `
        + `api p50 ${api.p50Ms}ms p95 ${api.p95Ms}ms (req ${api.requests}, err ${api.errors})`);
}
//# sourceMappingURL=format.js.map