# Changelog

All notable changes to this project are documented here. From the first release onward, [release-please](https://github.com/googleapis/release-please) owns this file — do not hand-edit version headings after `0.1.0` ships.

## [1.1.0](https://github.com/tbaur/homebridge-mynest/compare/v1.0.0...v1.1.0) (2026-08-01)


### Features

* allow diagnostics interval up to 24h as a number field ([#27](https://github.com/tbaur/homebridge-mynest/issues/27)) ([9f988f7](https://github.com/tbaur/homebridge-mynest/commit/9f988f7d2cc21c5e6e072ce1914b0d767aa0168e))

## [1.0.0](https://github.com/tbaur/homebridge-mynest/compare/v0.1.10...v1.0.0) (2026-07-31)


### Miscellaneous Chores

* graduate to 1.0.0 stable ([#24](https://github.com/tbaur/homebridge-mynest/issues/24)) ([376868d](https://github.com/tbaur/homebridge-mynest/commit/376868da24cf4b5b8dea45e7d60297ab78fa55e1))

## [0.1.10](https://github.com/tbaur/homebridge-mynest/compare/v0.1.9...v0.1.10) (2026-07-31)


### Features

* add Eco Mode switches and friendlier thermostat write logs ([#21](https://github.com/tbaur/homebridge-mynest/issues/21)) ([fa5f385](https://github.com/tbaur/homebridge-mynest/commit/fa5f3859df07da8d757f0f5ffe9b61facc3dffb9))

## [0.1.9](https://github.com/tbaur/homebridge-mynest/compare/v0.1.8...v0.1.9) (2026-07-31)


### Bug Fixes

* stop same-UUID thermostat republish that never restored tiles ([dc01a42](https://github.com/tbaur/homebridge-mynest/commit/dc01a4270adb292d43141716bce07f48d319ba05))

## [0.1.8](https://github.com/tbaur/homebridge-mynest/compare/v0.1.7...v0.1.8) (2026-07-31)


### Bug Fixes

* republish cached thermostats so Home shows room tiles ([9d97dd2](https://github.com/tbaur/homebridge-mynest/commit/9d97dd2d57598b5a25e3662b40d5ce4cffe52f65))

## [0.1.7](https://github.com/tbaur/homebridge-mynest/compare/v0.1.6...v0.1.7) (2026-07-31)


### Features

* add opt-in Nest BatchUpdateState thermostat control ([40f9f00](https://github.com/tbaur/homebridge-mynest/commit/40f9f008e8c7ff161e10b6c64aabd8d0e5f6c9f4))

## [0.1.6](https://github.com/tbaur/homebridge-mynest/compare/v0.1.5...v0.1.6) (2026-07-31)


### Bug Fixes

* never return null from required thermostat onGets ([#13](https://github.com/tbaur/homebridge-mynest/issues/13)) ([f3abd0f](https://github.com/tbaur/homebridge-mynest/commit/f3abd0f43931e58cbfc0e4f23505b1a5f109ee55))

## [0.1.5](https://github.com/tbaur/homebridge-mynest/compare/v0.1.4...v0.1.5) (2026-07-31)


### Bug Fixes

* set HAP accessory categories for HomeKit room tiles ([#11](https://github.com/tbaur/homebridge-mynest/issues/11)) ([cef3bb5](https://github.com/tbaur/homebridge-mynest/commit/cef3bb556cc067869078c8b1247a49bf5a2099a5))

## [0.1.4](https://github.com/tbaur/homebridge-mynest/compare/v0.1.3...v0.1.4) (2026-07-31)


### Bug Fixes

* stop cooling-threshold null spam and Observe boot prune ([#9](https://github.com/tbaur/homebridge-mynest/issues/9)) ([b940583](https://github.com/tbaur/homebridge-mynest/commit/b94058396908488afba62081fac037591ae973f3))

## [0.1.3](https://github.com/tbaur/homebridge-mynest/compare/v0.1.2...v0.1.3) (2026-07-31)


### Bug Fixes

* exclude subscribe latency and shorten operator logs ([#7](https://github.com/tbaur/homebridge-mynest/issues/7)) ([804985e](https://github.com/tbaur/homebridge-mynest/commit/804985e1d08676fbd7f08576e2019c1a02af61e0))

## [0.1.2](https://github.com/tbaur/homebridge-mynest/compare/v0.1.1...v0.1.2) (2026-07-31)


### Bug Fixes

* stop false observeDown and idle-subscribe latency skew ([#5](https://github.com/tbaur/homebridge-mynest/issues/5)) ([37cae38](https://github.com/tbaur/homebridge-mynest/commit/37cae38f88cef455552cc00009badd731f640e9b))

## [0.1.1](https://github.com/tbaur/homebridge-mynest/compare/v0.1.0...v0.1.1) (2026-07-31)


### Bug Fixes

* show Ignored Device IDs input in Homebridge UI ([#3](https://github.com/tbaur/homebridge-mynest/issues/3)) ([0e7d966](https://github.com/tbaur/homebridge-mynest/commit/0e7d9668ae1e9dc01da5fd5e04c8aceeae361fe6))

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
