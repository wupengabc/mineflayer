/* eslint-env mocha */

const assert = require('assert')
const { once } = require('events')
const { createBot } = require('..')
const { createClient } = require('minecraft-protocol')

describe('shared registry plugin initialization', () => {
  for (const version of ['1.8.8', '1.21.4', '26.2', '26.3']) {
    it(`initializes all internal plugins on ${version} without a server`, async () => {
      const client = createClient({ username: 'RegistryTest', auth: 'offline', version, autoConnect: false })
      const bot = createBot({ client, version, logErrors: false })
      try {
        await once(bot, 'inject_allowed')
        assert.strictEqual(bot.registry.version.minecraftVersion, version)
        assert.ok(bot.registry.blocksByName.stone)
        assert.ok(bot.inventory)
        assert.strictEqual(typeof bot.attack, 'function')
        assert.strictEqual(typeof bot.blockAt, 'function')
        assert.strictEqual(typeof bot.clickWindow, 'function')
      } finally {
        bot.emit('end', 'test complete')
      }
    })
  }
})
