"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One connection to Nest's Observe stream.
 *
 * Observe is an HTTP/2 POST whose response never ends: Nest sends a full trait
 * snapshot and then streams patches for as long as the connection lives. This
 * module owns exactly one such connection and always resolves with why it
 * finished, so the reconnect policy can live somewhere testable rather than
 * being tangled up with socket handling.
 *
 * The failure that matters here is not a dropped connection — that is obvious
 * and easy to recover from. It is a connection that stays open and stops
 * delivering, which is indistinguishable from a quiet house and leaves HomeKit
 * showing yesterday's temperature forever. That is what the idle deadline is
 * for.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runObserveSession = runObserveSession;
const node_crypto_1 = require("node:crypto");
const node_http2_1 = __importDefault(require("node:http2"));
const settings_1 = require("../settings");
const errors_1 = require("../errors");
const framing_1 = require("./framing");
const protobuf_1 = require("./protobuf");
/**
 * Headers the Nest gateway requires on an Observe request.
 *
 * `X-Accept-Response-Streaming` is what asks for the long-lived stream rather
 * than a single snapshot, and the referer/origin pair is checked: the gateway
 * is the Nest web app's private backend and rejects callers that do not look
 * like it.
 */
function observeHeaders(session, endpoints) {
    return {
        ':method': 'POST',
        ':path': endpoints.observePath,
        'User-Agent': settings_1.USER_AGENT,
        'Content-Type': 'application/x-protobuf',
        'X-Accept-Content-Transfer-Encoding': 'binary',
        'X-Accept-Response-Streaming': 'true',
        Authorization: `Basic ${session.token}`,
        'request-id': (0, node_crypto_1.randomUUID)(),
        // Must match the configured Nest environment. Field-test gRPC rejects a
        // production origin/referer the same way production rejects an FT one.
        referer: `https://${endpoints.apiHostname}/`,
        origin: `https://${endpoints.apiHostname}`,
        'x-nl-webapp-version': settings_1.WEB_APP_VERSION,
    };
}
/**
 * Open one Observe connection and pump frames until it ends.
 *
 * @returns Why the connection finished, for the caller's reconnect policy.
 * @throws {ObserveStreamError} On a transport or protocol failure.
 */
function runObserveSession(options) {
    const connect = options.connect ?? node_http2_1.default.connect;
    const sessionMs = options.sessionMs ?? settings_1.OBSERVE_SESSION_MS;
    const idleTimeoutMs = options.idleTimeoutMs ?? settings_1.OBSERVE_IDLE_TIMEOUT_MS;
    const pingIntervalMs = options.pingIntervalMs ?? settings_1.OBSERVE_PING_INTERVAL_MS;
    const traitsRequest = (0, protobuf_1.readObserveTraitsRequest)();
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const splitter = new framing_1.FrameSplitter();
        let frameCount = 0;
        let isSettled = false;
        const client = connect(options.endpoints.grpcOrigin, { maxOutstandingPings: 2 });
        const request = client.request(observeHeaders(options.session, options.endpoints));
        const timers = [];
        let idleTimer;
        /**
         * Tear everything down exactly once.
         *
         * Every path out of this function goes through here — success, failure,
         * abort, and each deadline — because an Observe connection that is not
         * closed keeps a socket, a ping interval, and a 300 KB frame buffer alive
         * for the lifetime of the Homebridge process.
         */
        const settle = (outcome) => {
            if (isSettled) {
                return;
            }
            isSettled = true;
            for (const timer of timers) {
                clearTimeout(timer);
                clearInterval(timer);
            }
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            options.signal?.removeEventListener('abort', onAbort);
            request.close();
            client.close();
            if ('error' in outcome) {
                reject(outcome.error);
                return;
            }
            resolve({
                reason: outcome.reason,
                frameCount,
                durationMs: Date.now() - startedAt,
            });
        };
        const onAbort = () => settle({ reason: 'aborted' });
        const resetIdleTimer = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }
            idleTimer = setTimeout(() => settle({ reason: 'idle' }), idleTimeoutMs);
            // The idle deadline must not be a reason to keep Node alive; Homebridge
            // owns the process lifetime.
            idleTimer.unref?.();
        };
        timers.push(setTimeout(() => settle({ reason: 'recycled' }), sessionMs));
        timers.push(setInterval(() => {
            // Nest drops a stream it believes is dead. Failing to ping is not itself
            // fatal — the idle deadline is the real backstop — so a rejected ping is
            // swallowed rather than tearing down a working connection.
            try {
                client.ping(() => undefined);
            }
            catch {
                /* the idle deadline will catch a genuinely dead stream */
            }
        }, pingIntervalMs));
        for (const timer of timers) {
            timer.unref?.();
        }
        options.signal?.addEventListener('abort', onAbort, { once: true });
        // HTTP/2 emits `response` then `end` with no `error` for 401/403/5xx, so
        // without this handler a rejected token looks like Nest recycling a healthy
        // stream (reason `ended`, frameCount 0) and the loop reconnects forever.
        request.on('response', (headers) => {
            const status = Number(headers[':status']);
            if (!Number.isFinite(status) || status < 400) {
                return;
            }
            if (status === 401) {
                settle({
                    error: new errors_1.AuthenticationError(`Observe gateway returned HTTP ${status}`),
                });
                return;
            }
            if (status === 403) {
                settle({
                    error: new errors_1.ForbiddenError(`Observe gateway returned HTTP ${status}`),
                });
                return;
            }
            settle({
                error: new errors_1.ObserveStreamError(`Observe gateway returned HTTP ${status}`),
            });
        });
        request.on('data', (chunk) => {
            resetIdleTimer();
            let frames;
            try {
                frames = splitter.push(chunk);
            }
            catch (error) {
                settle({
                    error: new errors_1.ObserveStreamError(`Could not parse the Observe stream: ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined }),
                });
                return;
            }
            for (const frame of frames) {
                frameCount++;
                try {
                    options.onFrame(frame);
                }
                catch (error) {
                    // A consumer that throws must not kill the transport; the next frame
                    // is very likely fine and dropping the stream costs live updates.
                    options.log.debug(`Observe frame handler threw: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        });
        request.on('end', () => settle({ reason: 'ended' }));
        request.on('error', (error) => settle({
            error: new errors_1.ObserveStreamError(`Observe stream failed: ${error.message}`, { cause: error }),
        }));
        client.on('error', (error) => settle({
            error: new errors_1.ObserveStreamError(`Observe connection failed: ${error.message}`, { cause: error }),
        }));
        client.on('close', () => settle({ reason: 'ended' }));
        resetIdleTimer();
        request.end(traitsRequest);
    });
}
//# sourceMappingURL=observe.js.map