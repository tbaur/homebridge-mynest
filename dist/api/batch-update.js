"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview POST Nest TraitBatchApi/BatchUpdateState.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.postBatchUpdateState = postBatchUpdateState;
const node_crypto_1 = require("node:crypto");
const settings_1 = require("../settings");
const errors_1 = require("../errors");
const sanitizers_1 = require("../utils/sanitizers");
const http_1 = require("./http");
/**
 * Send one BatchUpdateState request.
 *
 * The response body is protobuf (often empty-ish on success); callers care
 * about HTTP status, not a decoded payload.
 */
async function postBatchUpdateState(options) {
    const url = `${options.endpoints.grpcOrigin}${options.endpoints.batchUpdatePath}`;
    // Nest sees this id. Surfacing it in the failure message is the only way an
    // operator (or a Nest support request) can tie a log line back to the exact
    // request that produced it — generating one and discarding it buys nothing.
    const requestId = (0, node_crypto_1.randomUUID)();
    const response = await (0, http_1.sendRequest)(url, {
        method: 'POST',
        headers: {
            'User-Agent': settings_1.USER_AGENT,
            Authorization: `Basic ${options.session.token}`,
            'Content-Type': 'application/x-protobuf',
            'X-Accept-Content-Transfer-Encoding': 'binary',
            'X-Accept-Response-Streaming': 'true',
            'request-id': requestId,
            referer: `https://${options.endpoints.apiHostname}/`,
            origin: `https://${options.endpoints.apiHostname}`,
            'x-nl-webapp-version': settings_1.WEB_APP_VERSION,
        },
        body: options.body,
        timeoutMs: options.timeoutMs ?? settings_1.BATCH_UPDATE_TIMEOUT_MS,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
    });
    if (response.status >= 400) {
        throw (0, errors_1.createApiError)(response.status, `${(0, sanitizers_1.sanitizeUrl)(url)} returned HTTP ${response.status} [request-id ${requestId}]`, { retryAfterMs: (0, errors_1.parseRetryAfterMs)(response.headers.get('retry-after')) });
    }
}
//# sourceMappingURL=batch-update.js.map