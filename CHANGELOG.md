# Changelog

All notable changes to this project are documented here. From the first release onward, [release-please](https://github.com/googleapis/release-please) owns this file — do not hand-edit version headings after `0.1.0` ships.

## [0.1.1](https://github.com/tbaur/homebridge-mynest/compare/v0.1.0...v0.1.1) (2026-07-31)


### Bug Fixes

* show Ignored Device IDs input in Homebridge UI ([#3](https://github.com/tbaur/homebridge-mynest/issues/3)) ([0e7d966](https://github.com/tbaur/homebridge-mynest/commit/0e7d9668ae1e9dc01da5fd5e04c8aceeae361fe6))

## [Unreleased]

## 0.1.0

Initial public release of **homebridge-mynest**.

### Features

- Nest Account `access_token` authentication (Google JWT / `ya29.` shapes rejected at config validation)
- Dual transport: REST `app_launch` + `/v5/subscribe` merged with HTTP/2 Observe
- Nest thermostats (read-only), Nest Protect, and Nest Temperature Sensors in HomeKit
- Homebridge 2–safe characteristic updates via stored getters + `updateValue(...)`
- Honest Protect occupancy (REST `auto_away` / ~10-minute presence; mains-powered only)
- Smoke/CO published after Nest REST reports alarm state; REST outages and expired tokens keep tiles in HomeKit but mark them inactive/faulted rather than freezing a live all-clear or tearing services down
- Accessory removal only after Nest-confirmed drops (Observe + REST two-strike / truncation guards); transport outages and REST-only boots do not bounce rooms or automations
- Per-transport circuit breakers for sustained Nest edge failures
- Opt-in diagnostics heartbeats (`diagnosticsInterval` / `structuredLogs`)
- Observe device prune, rediscovery, and per-transport HTTP 403 budgets
