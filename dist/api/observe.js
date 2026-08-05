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
/** Grace period between a graceful `close()` and a forced `destroy()`. */
const CLIENT_DESTROY_GRACE_MS = 5_000;
/**
 * Frame-handler failures warned about per connection before dropping to debug.
 *
 * A consumer bug throws on every frame, so this must be visible without
 * flooding the log.
 */
const MAX_HANDLER_FAILURE_WARNINGS = 3;
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
function observeHeaders(session, endpoints, requestId) {
    return {
        ':method': 'POST',
        ':path': endpoints.observePath,
        'User-Agent': settings_1.USER_AGENT,
        'Content-Type': 'application/x-protobuf',
        'X-Accept-Content-Transfer-Encoding': 'binary',
        'X-Accept-Response-Streaming': 'true',
        Authorization: `Basic ${session.token}`,
        'request-id': requestId,
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
    const connectTimeoutMs = options.connectTimeoutMs ?? settings_1.OBSERVE_CONNECT_TIMEOUT_MS;
    const traitsRequest = (0, protobuf_1.readObserveTraitsRequest)();
    const startedAt = Date.now();
    // Sent to Nest and echoed into every failure from this connection, so a log
    // line can be tied back to the stream that produced it.
    const requestId = (0, node_crypto_1.randomUUID)();
    return new Promise((resolve, reject) => {
        const splitter = new framing_1.FrameSplitter();
        let frameCount = 0;
        let handlerFailures = 0;
        let isSettled = false;
        const client = connect(options.endpoints.grpcOrigin, { maxOutstandingPings: 2 });
        // Registered before anything can throw: an unhandled `error` on an
        // Http2Session is a hard process crash.
        client.on('error', (error) => settle({
            error: new errors_1.ObserveStreamError(`Observe connection failed [request-id ${requestId}]: ${error.message}`, { cause: error }),
        }));
        let request;
        try {
            request = client.request(observeHeaders(options.session, options.endpoints, requestId));
        }
        catch (error) {
            // Nothing has been wired up yet, so `settle` cannot clean up for us —
            // and leaving the session open leaks a socket and its TLS state on every
            // reconnect attempt, indefinitely.
            client.destroy();
            reject(new errors_1.ObserveStreamError(`Could not open the Observe stream [request-id ${requestId}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined }));
            return;
        }
        const timers = [];
        let idleTimer;
        let connectTimer;
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
            if (connectTimer) {
                clearTimeout(connectTimer);
            }
            options.signal?.removeEventListener('abort', onAbort);
            request.close();
            client.close();
            // `close()` is graceful and waits for streams to settle, which a stream
            // that went silent may never do — and the `idle` outcome exists
            // precisely for a socket that is up but not delivering. Force the
            // teardown shortly after so a half-dead session cannot linger.
            if (!client.destroyed) {
                const destroyTimer = setTimeout(() => {
                    if (!client.destroyed) {
                        client.destroy();
                    }
                }, CLIENT_DESTROY_GRACE_MS);
                destroyTimer.unref?.();
                client.once('close', () => clearTimeout(destroyTimer));
            }
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
        // The idle deadline is ten minutes, which is right for a connected stream
        // that goes quiet but far too long for one that never connects at all.
        // A blackholed route would otherwise stall the only source of thermostat
        // state for ten minutes per attempt.
        connectTimer = setTimeout(() => {
            connectTimer = undefined;
            settle({
                error: new errors_1.ObserveStreamError(`Observe gateway did not respond within ${connectTimeoutMs}ms [request-id ${requestId}]`),
            });
        }, connectTimeoutMs);
        connectTimer.unref?.();
        const clearConnectDeadline = () => {
            if (connectTimer) {
                clearTimeout(connectTimer);
                connectTimer = undefined;
            }
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
            clearConnectDeadline();
            const status = Number(headers[':status']);
            if (!Number.isFinite(status) || status < 400) {
                return;
            }
            if (status === 401) {
                settle({
                    error: new errors_1.AuthenticationError(`Observe gateway returned HTTP ${status} [request-id ${requestId}]`),
                });
                return;
            }
            if (status === 403) {
                settle({
                    error: new errors_1.ForbiddenError(`Observe gateway returned HTTP ${status} [request-id ${requestId}]`),
                });
                return;
            }
            settle({
                error: new errors_1.ObserveStreamError(`Observe gateway returned HTTP ${status} [request-id ${requestId}]`),
            });
        });
        request.on('data', (chunk) => {
            clearConnectDeadline();
            resetIdleTimer();
            let frames;
            try {
                frames = splitter.push(chunk);
            }
            catch (error) {
                settle({
                    error: new errors_1.ObserveStreamError(`Could not parse the Observe stream [request-id ${requestId}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined }),
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
                    // But it must not be invisible either: this is the catch that would
                    // otherwise swallow a state-layer bug on every single frame.
                    handlerFailures++;
                    const message = `Observe frame ${frameCount} handler failed `
                        + `(${handlerFailures} total): `
                        + `${error instanceof Error ? error.message : String(error)}`;
                    if (handlerFailures <= MAX_HANDLER_FAILURE_WARNINGS) {
                        options.log.warn(message);
                    }
                    else {
                        options.log.debug(message);
                    }
                }
            }
        });
        request.on('end', () => settle({ reason: 'ended' }));
        request.on('error', (error) => settle({
            error: new errors_1.ObserveStreamError(`Observe stream failed [request-id ${requestId}]: ${error.message}`, { cause: error }),
        }));
        client.on('close', () => settle({ reason: 'ended' }));
        resetIdleTimer();
        request.end(traitsRequest);
    });
}
