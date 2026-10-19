'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const injectPhysics = require('../lib/plugins/physics')

const emptyInputs = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  jump: false,
  shift: false,
  sprint: false
}

describe('real physics plugin movement reporting', function () {
  let now
  let timers
  let bots
  let originalSetInterval
  let originalClearInterval
  let originalNow

  beforeEach(function () {
    now = 0
    timers = new Set()
    bots = []
    originalSetInterval = global.setInterval
    originalClearInterval = global.clearInterval
    originalNow = performance.now
    global.setInterval = (callback, interval) => {
      assert.strictEqual(interval, 50)
      timers.add(callback)
      return callback
    }
    global.clearInterval = timer => timers.delete(timer)
    performance.now = () => now
  })

  afterEach(function () {
    try {
      for (const bot of bots) bot.emit('end')
      assert.strictEqual(timers.size, 0)
    } finally {
      global.setInterval = originalSetInterval
      global.clearInterval = originalClearInterval
      performance.now = originalNow
    }
  })

  function tick (count = 1) {
    for (let i = 0; i < count; i++) {
      now += 50
      for (const callback of timers) callback()
    }
  }

  function createBot (version = '26.2', options = {}) {
    const bot = new EventEmitter()
    bot.version = version
    bot.registry = require('minecraft-data')(version)
    bot.protocolVersion = bot.registry.version.version
    bot.supportFeature = name => bot.registry.supportFeature(name)
    bot.entity = {
      id: 1,
      position: new Vec3(0, 0, 0),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: false,
      isCollidedHorizontally: false
    }
    bot.isAlive = true
    bot.blockAt = () => ({})
    bot._client = new EventEmitter()
    bot._client.state = 'play'
    bot._client.writes = []
    bot._client.write = (name, params) => {
      bot._client.writes.push({ name, params: structuredClone(params), tick: now / 50 })
    }

    // Exercise the actual timer, correction and reporting paths without world motion.
    injectPhysics(bot, { physicsEnabled: false, ...options })
    bots.push(bot)
    bot.emit('login')
    bot._client.emit('position', {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1
    })
    bot._client.writes.length = 0
    return bot
  }

  function packets (bot, ...names) {
    return bot._client.writes.filter(packet => names.includes(packet.name))
  }

  function correctPosition (bot) {
    bot._client.emit('position', {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 2
    })
  }

  for (const cap of [1, 4, 10]) {
    it(`discards excess stall debt after one batch of ${cap} ticks`, function () {
      const bot = createBot('26.2', { maxCatchupTicks: cap })
      const lag = []
      bot.on('physicsLag', event => lag.push(event))
      now += 2025
      for (const callback of timers) callback()
      assert.strictEqual(packets(bot, 'tick_end').length, cap)
      assert.deepStrictEqual(lag, [{ elapsedMs: 2025, processedTicks: cap, skippedTicks: 40 - cap }])

      tick()
      assert.strictEqual(packets(bot, 'tick_end').length, cap + 1)
      now += 25
      for (const callback of timers) callback()
      assert.strictEqual(packets(bot, 'tick_end').length, cap + 2, 'preserves the fractional tick')
      tick(20)
      assert.strictEqual(packets(bot, 'tick_end').length, cap + 22, 'resumes normal cadence')
      assert.strictEqual(lag.length, 1)
    })
  }

  it('preserves ordinary timer jitter without reporting a stall', function () {
    const bot = createBot()
    const lag = []
    bot.on('physicsLag', event => lag.push(event))
    for (let i = 0; i < 100; i++) {
      now += 64
      for (const callback of timers) callback()
      now += 36
      for (const callback of timers) callback()
    }
    assert.strictEqual(packets(bot, 'tick_end').length, 200)
    assert.deepStrictEqual(lag, [])
  })

  it('does not keep accelerating synchronous physicsTick actions after a long pause', function () {
    const bot = createBot()
    bot.inventory = { slots: [] }
    bot.entity.effects = {}
    bot.physics.simulatePlayer = () => ({ apply: () => {} })
    bot.physicsEnabled = true
    let actions = 0
    bot.on('physicsTick', () => { actions++ })
    now += 5000
    for (const callback of timers) callback()
    assert.strictEqual(actions, 4)
    tick(20)
    assert.strictEqual(actions, 24)
  })

  it('resends held controls after a backend login replaces the player', function () {
    const bot = createBot()
    bot.setControlState('forward', true)
    bot.setControlState('sneak', true)
    tick()
    bot._client.writes.length = 0
    bot._client.emit('start_configuration')
    bot.emit('login')
    correctPosition(bot)
    tick()
    assert.deepStrictEqual(packets(bot, 'player_input').map(p => p.params.inputs), [
      { ...emptyInputs, forward: true, shift: true }
    ])
  })

  for (const copyMetadata of [0, 2]) {
    it(`handles respawn input preservation with copyMetadata=${copyMetadata}`, function () {
      const bot = createBot()
      bot.setControlState('forward', true)
      tick()
      bot._client.writes.length = 0
      bot.emit('respawn')
      bot._client.emit('respawn', { copyMetadata })
      correctPosition(bot)
      tick()
      assert.strictEqual(packets(bot, 'player_input').length, copyMetadata & 2 ? 0 : 1)
    })
  }

  it('sends complete sneak input while mounted so dismounting still works', function () {
    const bot = createBot()
    bot.vehicle = { id: 2 }
    bot.emit('mount')
    bot.setControlState('sneak', true)
    tick()
    tick(9)
    assert.deepStrictEqual(packets(bot, 'player_input').map(p => p.params.inputs), [
      { ...emptyInputs, shift: true }
    ])
  })

  it('does not mutate movement snapshots waiting in the transport queue', function () {
    const bot = createBot()
    const queue = []
    bot._client.write = (name, params) => queue.push({ name, params })
    bot.entity.position.x = 1
    tick()
    bot.entity.position.x = 2
    bot.entity.pitch = 0.1
    tick()
    const moves = queue.filter(packet => ['position', 'position_look'].includes(packet.name))
    assert.deepStrictEqual(moves.map(packet => packet.params.x), [1, 2])
    assert.notStrictEqual(moves[0].params, moves[1].params)
  })

  for (const version of ['1.18.2', '1.21.4', '26.2']) {
    it(`uses the strict modern displacement threshold on ${version}`, function () {
      const bot = createBot(version)
      bot.entity.position.x = 0.0001
      tick()
      bot.entity.position.x = 0.0002
      tick()
      assert.deepStrictEqual(packets(bot, 'position', 'position_look'), [])

      bot.entity.position.x = 0.000201
      tick()
      const sent = packets(bot, 'position', 'position_look')
      assert.strictEqual(sent.length, 1)
      assert.strictEqual(sent[0].name, 'position')
      assert.strictEqual(sent[0].params.x, 0.000201)
    })
  }

  it('accumulates three-dimensional drift from the last reported position', function () {
    const bot = createBot()
    bot.entity.position.set(0.0001, 0.0001, 0.0001)
    tick()
    assert.deepStrictEqual(packets(bot, 'position'), [])
    bot.entity.position.set(0.00012, 0.00012, 0.00012)
    tick()
    assert.strictEqual(packets(bot, 'position').length, 1)
    bot.entity.position.set(0.00022, 0.00022, 0.00022)
    tick()
    assert.strictEqual(packets(bot, 'position').length, 1)
    bot.entity.position.set(0.00024, 0.00024, 0.00024)
    tick()
    assert.strictEqual(packets(bot, 'position').length, 2)
  })

  for (const version of ['1.12.2', '1.18.1']) {
    it(`retains the strict 0.03 threshold on ${version}`, function () {
      const bot = createBot(version)
      bot.entity.position.x = 0.000201
      tick()
      bot.entity.position.x = 0.03
      tick()
      assert.deepStrictEqual(packets(bot, 'position', 'position_look'), [])
      bot.entity.position.x = 0.030001
      tick()
      assert.strictEqual(packets(bot, 'position').length, 1)
    })
  }

  it('keeps the 20-tick position heartbeat despite look and status packets', function () {
    const bot = createBot()
    tick(9)
    bot.entity.pitch = 0.1
    tick()
    tick(4)
    bot.entity.onGround = true
    tick()
    tick(2)
    bot.entity.isCollidedHorizontally = true
    tick()
    tick(22)

    assert.deepStrictEqual(packets(bot, 'look').map(packet => packet.tick), [10])
    assert.deepStrictEqual(packets(bot, 'flying').map(packet => packet.tick), [15, 18])
    assert.deepStrictEqual(packets(bot, 'position').map(packet => packet.tick), [20, 40])
    assert.strictEqual(packets(bot, 'tick_end').length, 40)
  })

  it('resets the heartbeat when a displaced position is actually reported', function () {
    const bot = createBot()
    tick(9)
    bot.entity.position.x = 1
    tick()
    tick(19)
    assert.deepStrictEqual(packets(bot, 'position').map(packet => packet.tick), [10])
    tick()
    assert.deepStrictEqual(packets(bot, 'position').map(packet => packet.tick), [10, 30])
  })

  for (const version of ['1.21.3', '26.2']) {
    it(`reports collision-only transitions once with both flags on ${version}`, function () {
      const bot = createBot(version)
      bot.entity.isCollidedHorizontally = true
      tick(2)
      bot.entity.isCollidedHorizontally = false
      tick(2)
      bot.entity.onGround = true
      bot.entity.isCollidedHorizontally = true
      tick(2)
      assert.deepStrictEqual(packets(bot, 'flying').map(packet => packet.params.flags), [
        { onGround: false, hasHorizontalCollision: true },
        { onGround: false, hasHorizontalCollision: false },
        { onGround: true, hasHorizontalCollision: true }
      ])
      assert.strictEqual(packets(bot, 'tick_end').length, 6)
    })
  }

  it('includes changed collision flags in a look packet without a later duplicate status', function () {
    const bot = createBot()
    bot.entity.pitch = 0.1
    bot.entity.isCollidedHorizontally = true
    tick(2)
    assert.deepStrictEqual(packets(bot, 'look').map(packet => packet.params.flags), [
      { onGround: false, hasHorizontalCollision: true }
    ])
    assert.deepStrictEqual(packets(bot, 'flying'), [])
  })

  it('does not add collision-only status packets to legacy protocols', function () {
    const bot = createBot('1.21.1')
    bot.entity.isCollidedHorizontally = true
    tick()
    bot.entity.isCollidedHorizontally = false
    tick()
    assert.deepStrictEqual(packets(bot, 'flying', 'position', 'position_look', 'look'), [])
    bot.entity.onGround = true
    tick()
    assert.strictEqual(packets(bot, 'flying').length, 1)
  })

  it('preserves the every-tick legacy flying packet', function () {
    const bot = createBot('1.8.9')
    tick(3)
    assert.strictEqual(packets(bot, 'flying').length, 3)
  })

  it('sends no unchanged input during 100 idle ticks', function () {
    const bot = createBot()
    tick(100)
    assert.deepStrictEqual(packets(bot, 'player_input'), [])
    assert.strictEqual(packets(bot, 'tick_end').length, 100)
    assert.deepStrictEqual(packets(bot, 'position').map(packet => packet.tick), [20, 40, 60, 80, 100])
  })

  it('sends full held-forward and sneak changes only at tick boundaries', function () {
    const bot = createBot()
    bot.setControlState('forward', true)
    tick(2)
    bot.setControlState('sneak', true)
    assert.strictEqual(packets(bot, 'player_input').length, 1)
    tick(2)
    bot.setControlState('sneak', false)
    assert.strictEqual(packets(bot, 'player_input').length, 2)
    tick(2)
    assert.deepStrictEqual(packets(bot, 'player_input').map(packet => packet.params.inputs), [
      { ...emptyInputs, forward: true },
      { ...emptyInputs, forward: true, shift: true },
      { ...emptyInputs, forward: true }
    ])
    assert.deepStrictEqual(packets(bot, 'entity_action'), [])
  })

  it('tracks all seven flags independently, including opposite directions', function () {
    const bot = createBot()
    const controls = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
    for (const control of controls) bot.setControlState(control, true)
    tick(2)
    const expected = Object.fromEntries(Object.keys(emptyInputs).map(key => [key, true]))
    assert.deepStrictEqual(packets(bot, 'player_input').map(packet => packet.params.inputs), [{ ...expected }])

    for (const control of controls) {
      bot.setControlState(control, false)
      tick()
      expected[control === 'back' ? 'backward' : control === 'sneak' ? 'shift' : control] = false
      const sent = packets(bot, 'player_input')
      assert.deepStrictEqual(sent[sent.length - 1].params.inputs, expected)
    }
    tick(2)
    assert.strictEqual(packets(bot, 'player_input').length, 8)
  })

  it('coalesces an input press and release within one tick', function () {
    const bot = createBot()
    bot.setControlState('sneak', true)
    bot.setControlState('sneak', false)
    tick()
    assert.deepStrictEqual(packets(bot, 'player_input'), [])
  })

  it('preserves legacy sneak actions without modern input packets', function () {
    const bot = createBot('1.18.2')
    bot.setControlState('sneak', true)
    bot.setControlState('sneak', false)
    tick()
    assert.deepStrictEqual(packets(bot, 'entity_action').map(packet => packet.params.actionId), [0, 1])
    assert.deepStrictEqual(packets(bot, 'player_input'), [])
  })
})
