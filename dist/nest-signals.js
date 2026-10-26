"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Which Nest conditions are worth a PagerDuty page.
 *
 * The store writer is the copied module. This file owns the house-level OR
 * over every Protect, the grace before a stale alarm feed pages, and which
 * fatal errors mean the plugin has stopped. A device name never enters a
 * summary.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NestSignals = exports.CONFIG_INVALID_SUMMARY = exports.SESSION_FORMAT_SUMMARY = exports.TOKEN_REJECTED_SUMMARY = exports.ALARM_FEED_STALE_SUMMARY = exports.CO_SUMMARY = exports.SMOKE_SUMMARY = exports.ALARM_FEED_STALE_GRACE_MS = exports.SIGNAL_AUTH_FAILED = exports.SIGNAL_ALARM_FEED_STALE = exports.SIGNAL_CO = exports.SIGNAL_SMOKE = exports.PAGERDUTY_STARTUP_LOG = void 0;
/** Logged once, in this order, when the setting is on. */
exports.PAGERDUTY_STARTUP_LOG = 'homebridge-pagerduty support is enabled (smoke, co, alarm-feed-stale, auth-failed)';
exports.SIGNAL_SMOKE = 'smoke';
exports.SIGNAL_CO = 'co';
exports.SIGNAL_ALARM_FEED_STALE = 'alarm-feed-stale';
exports.SIGNAL_AUTH_FAILED = 'auth-failed';
/** How long the alarm feed must stay unavailable before it pages. */
exports.ALARM_FEED_STALE_GRACE_MS = 5 * 60_000;
exports.SMOKE_SUMMARY = 'A Nest Protect detects smoke.';
exports.CO_SUMMARY = 'A Nest Protect detects carbon monoxide.';
exports.ALARM_FEED_STALE_SUMMARY = 'Nest Protect smoke and CO readings are stale. HomeKit may not show an alarm.';
exports.TOKEN_REJECTED_SUMMARY = 'Nest rejected the access token. This plugin has stopped, so Protect smoke and CO no longer reach HomeKit.';
exports.SESSION_FORMAT_SUMMARY = 'Nest changed its session format. This plugin has stopped, so Protect smoke and CO no longer reach HomeKit.';
exports.CONFIG_INVALID_SUMMARY = 'The Nest access token in Homebridge is missing or invalid. This plugin has stopped, so Protect smoke and CO no longer reach HomeKit.';
const STOP_SUMMARIES = {
    token: exports.TOKEN_REJECTED_SUMMARY,
    session: exports.SESSION_FORMAT_SUMMARY,
    config: exports.CONFIG_INVALID_SUMMARY,
};
function isAlarming(level) {
    return level === 'warning' || level === 'emergency';
}
/**
 * House-level PagerDuty signals for the Protects and the plugin itself.
 *
 * Smoke and CO are written only while the alarm feed is fresh, so a stale
 * reading neither raises nor clears them. A feed that stays unavailable for
 * the grace period raises alarm-feed-stale instead. Once the plugin stops on
 * a fatal error, auth-failed stays raised and nothing else is written.
 * Shutdown closes the writer and leaves every row as it was.
 */
class NestSignals {
    #writer;
    #graceMs;
    #staleTimer = null;
    #isFeedStaleRaised = false;
    #hasStarted = false;
    #hasStopped = false;
    #isClosed = false;
    constructor(writer, graceMs = exports.ALARM_FEED_STALE_GRACE_MS) {
        this.#writer = writer;
        this.#graceMs = graceMs;
    }
    /**
     * Write auth-failed and alarm-feed-stale clear, and start the alarm feed grace.
     *
     * Call once, before the first request. The write lists this plugin in
     * homebridge-pagerduty even if Nest never answers, and the grace timer pages
     * for a feed that is already down at launch. Smoke and CO wait for a fresh
     * feed, so a restart cannot clear a real alarm.
     */
    start() {
        if (this.#isClosed || this.#hasStarted || this.#hasStopped) {
            return;
        }
        this.#hasStarted = true;
        this.#writeAuthFailedClear();
        this.#writeFeedStale(false);
        this.#armStaleTimer();
    }
    /** Nest accepted the token. Clears auth-failed. */
    noteConnected() {
        if (this.#isClosed || this.#hasStopped) {
            return;
        }
        this.#writeAuthFailedClear();
    }
    /** Record the Protects HomeKit is showing and whether their alarm feed is fresh. */
    update(protects, isFeedAvailable) {
        if (this.#isClosed || this.#hasStopped) {
            return;
        }
        if (!isFeedAvailable) {
            this.#armStaleTimer();
            return;
        }
        this.#clearStaleTimer();
        this.#isFeedStaleRaised = false;
        this.#writeFeedStale(false);
        this.#writer.write(exports.SIGNAL_SMOKE, {
            active: protects.some((protect) => isAlarming(protect.smoke)),
            severity: 'critical',
            summary: exports.SMOKE_SUMMARY,
        });
        this.#writer.write(exports.SIGNAL_CO, {
            active: protects.some((protect) => isAlarming(protect.carbonMonoxide)),
            severity: 'critical',
            summary: exports.CO_SUMMARY,
        });
    }
    /**
     * The plugin stopped and will not recover without a restart.
     *
     * Raises auth-failed and lowers alarm-feed-stale, so the user gets one page
     * that names the fix. Smoke and CO keep their last written value.
     */
    noteStopped(reason) {
        if (this.#isClosed || this.#hasStopped) {
            return;
        }
        this.#hasStopped = true;
        this.#clearStaleTimer();
        this.#writer.write(exports.SIGNAL_AUTH_FAILED, {
            active: true,
            severity: 'error',
            summary: STOP_SUMMARIES[reason],
        });
        this.#writeFeedStale(false);
    }
    /** Close the store and stop the grace timer. Does not clear any signal. */
    close() {
        if (this.#isClosed) {
            return;
        }
        this.#isClosed = true;
        this.#clearStaleTimer();
        this.#writer.close();
    }
    #writeAuthFailedClear() {
        this.#writer.write(exports.SIGNAL_AUTH_FAILED, {
            active: false,
            severity: 'error',
            summary: exports.TOKEN_REJECTED_SUMMARY,
        });
    }
    #writeFeedStale(active) {
        this.#writer.write(exports.SIGNAL_ALARM_FEED_STALE, {
            active,
            severity: 'error',
            summary: exports.ALARM_FEED_STALE_SUMMARY,
        });
    }
    #armStaleTimer() {
        if (this.#staleTimer !== null || this.#isFeedStaleRaised) {
            return;
        }
        // close() and noteStopped() clear this timer, so it never fires after either.
        this.#staleTimer = setTimeout(() => {
            this.#staleTimer = null;
            this.#isFeedStaleRaised = true;
            this.#writeFeedStale(true);
        }, this.#graceMs);
        this.#staleTimer.unref?.();
    }
    #clearStaleTimer() {
        if (this.#staleTimer !== null) {
            clearTimeout(this.#staleTimer);
            this.#staleTimer = null;
        }
    }
}
exports.NestSignals = NestSignals;
