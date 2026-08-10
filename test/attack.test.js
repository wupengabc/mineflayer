'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const injectEntities = require('../lib/plugins/entities')
const injectPackets261 = require('../lib/plugins/packets26_1')

function makeBot (version) {
  const registry = require('prismarine-registry')(version)
  const client = new EventEmitter()
  const bot = new EventEmitter()

  client.write = (name, params) => bot.writes.push({ name, params })
  bot.writes = []
  bot.version = version
  bot.protocolVersion = registry.version.version
  bot.registry = registry
  bot._client = client
  bot.supportFeature = registry.supportFeature
  bot.getControlState = () => false

  injectEntities(bot)
  injectPackets261(bot)
  return bot
}

describe('bot.attack', function () {
  it('waits for player_loaded before attacking on 26.1', function () {
    const bot = makeBot('26.1.2')

    bot.attack({ id: 42 })
    assert.deepStrictEqual(bot.writes, [])

    bot.emit('chunkColumnLoad')
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
      'player_loaded',
      'attack',
      'arm_animation'
    ])
    assert.deepStrictEqual(bot.writes[1].params, { entityId: 42 })

    bot.emit('chunkColumnLoad')
    assert.strictEqual(bot.writes.filter(packet => packet.name === 'player_loaded').length, 2)
    assert.strictEqual(bot.writes.filter(packet => packet.name === 'attack').length, 1)
  })

  it('waits for player_loaded before attacking on 26.2', function () {
    const bot = makeBot('26.2')

    bot.attack({ id: 42 })
    assert.deepStrictEqual(bot.writes, [])

    bot.emit('chunkColumnLoad')
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
      'player_loaded',
      'attack',
      'arm_animation'
    ])

    bot.emit('chunkColumnLoad')
    assert.strictEqual(bot.writes.filter(packet => packet.name === 'player_loaded').length, 2)
  })

  it('does not gate legacy protocol attacks', function () {
    const bot = makeBot('1.21.11')

    bot.attack({ id: 42 })
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
      'use_entity',
      'arm_animation'
    ])
  })

  it('resets the load gate after respawn', function () {
    const bot = makeBot('26.1.2')

    bot.emit('chunkColumnLoad')
    bot.writes.length = 0
    bot._client.emit('respawn')
    bot.attack({ id: 42 })
    assert.deepStrictEqual(bot.writes, [])

    bot.emit('chunkColumnLoad')
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
      'player_loaded',
      'attack',
      'arm_animation'
    ])
  })

  it('resets the load gate after server reconfiguration', function () {
    const bot = makeBot('26.2')

    bot.emit('chunkColumnLoad')
    bot.writes.length = 0
    bot._client.emit('start_configuration')
    bot.attack({ id: 42 })
    assert.deepStrictEqual(bot.writes, [])

    bot.emit('chunkColumnLoad')
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
      'player_loaded',
      'attack',
      'arm_animation'
    ])
  })
})
