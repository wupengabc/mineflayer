'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const packets261 = require('../lib/plugins/packets26_1')
const injectEntities = require('../lib/plugins/entities')
const injectPhysics = require('../lib/plugins/physics')

describe('protocol 26.2 packet bridge', function () {
  it('forwards 776 raw packets and preserves their protocol version', function () {
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    bot.protocolVersion = 776
    bot.entity = null
    bot.supportFeature = () => false
    bot._warn = () => {}
    packets261(bot)

    const received = new Promise((resolve) => bot.once('packetUnimplemented', resolve))
    bot._client.emit('rawPacket', {
      packetId: 0x7f,
      state: 'play',
      protocolVersion: 776
    })

    return received.then((packet) => {
      assert.deepStrictEqual(packet, {
        packetId: 0x7f,
        state: 'play',
        protocolVersion: 776,
        name: 'unimplemented_play_0x7f'
      })
      assert.strictEqual(packets261.tagWith261(new Error('test'), 776).protocolVersion, 776)
    })
  })

  it('keeps 26.2 lpVec3 entity velocity in blocks per tick', function () {
    const bot = new EventEmitter()
    bot.protocolVersion = 776
    bot.version = '1.21.4'
    bot.registry = {
      mobs: {},
      entitiesArray: [],
      entities: {}
    }
    bot.supportFeature = () => false
    bot._client = new EventEmitter()
    bot._client.write = () => {}

    injectEntities(bot)
    bot._client.emit('login', { entityId: 1 })
    bot._client.emit('entity_velocity', {
      entityId: 1,
      velocity: { x: 0.4, y: 0.1, z: -0.2 }
    })

    assert.strictEqual(bot.entity.velocity.x, 0.4)
    assert.strictEqual(bot.entity.velocity.y, 0.1)
    assert.strictEqual(bot.entity.velocity.z, -0.2)
  })

  it('keeps legacy entity velocity conversion before 26.1', function () {
    const bot = new EventEmitter()
    bot.protocolVersion = 774
    bot.version = '1.21.4'
    bot.registry = {
      mobs: {},
      entitiesArray: [],
      entities: {}
    }
    bot.supportFeature = () => false
    bot._client = new EventEmitter()
    bot._client.write = () => {}

    injectEntities(bot)
    bot._client.emit('login', { entityId: 1 })
    bot._client.emit('entity_velocity', {
      entityId: 1,
      velocity: { x: 800, y: -1600, z: 400 }
    })

    assert.strictEqual(bot.entity.velocity.x, 0.1)
    assert.strictEqual(bot.entity.velocity.y, -0.2)
    assert.strictEqual(bot.entity.velocity.z, 0.05)
  })

  it('replays missed 26.2 physics ticks to hold the 20Hz cadence', function () {
    const originalSetInterval = global.setInterval
    const originalNow = performance.now
    let now = 0
    let tick

    global.setInterval = (callback) => {
      tick = callback
      return {}
    }
    performance.now = () => now

    try {
      const bot = new EventEmitter()
      bot.protocolVersion = 776
      bot.version = '1.21.4'
      bot.registry = require('minecraft-data')(bot.version)
      bot.entity = {
        position: new Vec3(0, 64, 0),
        velocity: new Vec3(0, 0, 0),
        yaw: 0,
        pitch: 0,
        onGround: true
      }
      bot.inventory = { slots: [] }
      bot.isAlive = true
      bot.blockAt = () => ({})
      bot.supportFeature = (name) => name === 'sendsClientTickEndPacket'
      bot._client = new EventEmitter()
      bot._client.writes = []
      bot._client.write = (name, params) => bot._client.writes.push({ name, params })

      injectPhysics(bot, { physicsEnabled: false })
      bot.emit('login')
      // tickPhysics no-ops outside the play state (commit 3db9961) — the mock
      // must advertise 'play' or tick_end is never written.
      bot._client.state = 'play'
      bot._client.emit('position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: {} })
      bot._client.writes.length = 0

      // 200ms of accumulated time in one frame = 4 physics ticks. Recovering
      // them keeps the tick_end cadence at 20Hz; the pre-fix behavior of
      // "at most one tick per frame" is what let Windows setInterval jitter
      // (~57-63ms frames) throttle the bot to ~17.5Hz and desync it from the
      // server anti-cheat's tick-aligned expectations.
      now = 200
      tick()
      assert.deepStrictEqual(bot._client.writes.map(packet => packet.name), [
        'tick_end', 'tick_end', 'tick_end', 'tick_end'
      ])

      // A 1ms frame does not accumulate a full 50ms timestep, so no new tick.
      now = 201
      tick()
      assert.strictEqual(bot._client.writes.length, 4)
    } finally {
      performance.now = originalNow
      global.setInterval = originalSetInterval
    }
  })
})
