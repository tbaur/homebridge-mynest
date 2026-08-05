/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The plugin entry point.
 *
 * This is the single function Homebridge calls. Swapping its two arguments, or
 * letting PLUGIN_NAME drift from the package name, makes the plugin silently
 * fail to load for every user — and neither the type system nor any other test
 * would catch it.
 */

import registerPlugin from '../../src/index'
import { MyNestPlatform } from '../../src/platform'
import { PLATFORM_NAME, PLUGIN_NAME } from '../../src/settings'

describe('plugin entry point', () => {
  it('registers the platform under the documented identifiers', () => {
    const registerPlatform = jest.fn()

    registerPlugin({ registerPlatform } as never)

    expect(registerPlatform).toHaveBeenCalledTimes(1)
    expect(registerPlatform).toHaveBeenCalledWith(
      'homebridge-mynest',
      'MyNest',
      MyNestPlatform,
    )
  })

  it('keeps PLUGIN_NAME identical to the package name', () => {
    // Homebridge matches the registered plugin name against package.json; a
    // mismatch is a silent load failure.
    const { name } = require('../../package.json') as { name: string }

    expect(PLUGIN_NAME).toBe(name)
  })

  it('keeps PLATFORM_NAME identical to the config schema alias', () => {
    // The alias is what users put in `config.json` under `"platform"`.
    const { pluginAlias } = require('../../config.schema.json') as { pluginAlias: string }

    expect(PLATFORM_NAME).toBe(pluginAlias)
  })
})
