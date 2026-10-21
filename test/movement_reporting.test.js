'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const injectPhysics = require('../lib/plugins/physics')
const protocol = require('minecraft-protocol')

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
    const { loaded = true, serialize = false, ...physicsOptions } = options
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
    const serializer = serialize && protocol.createSerializer({ state: 'play', version, isServer: false })
    const parser = serialize && protocol.createDeserializer({ state: 'play', version, isServer: true })
    bot._client.write = (name, params) => {
      if (serialize) {
        const bytes = serializer.createPacketBuffer({ name, params })
        const decoded = parser.parsePacketBuffer(bytes)
        assert.strictEqual(decoded.metadata.size, bytes.length, `${name} consumes its complete serialized packet`)
        assert.strictEqual(decoded.data.name, name)
        params = decoded.data.params
      }
      bot._client.writes.push({ name, params: structuredClone(params), tick: now / 50 })
    }

    // Exercise the actual timer, correction and reporting paths without world motion.
    injectPhysics(bot, { physicsEnabled: false, ...physicsOptions })
    bots.push(bot)
    bot.emit('login')
    bot._client.emit('position', {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1
    })
    if (loaded) bot.emit('playerLoaded')
    bot._client.writes.length = 0
    return bot
  }

  function packets (bot, ...names) {
    return bot._client.writes.filter(packet => names.includes(packet.name))
  }

  for (const version of ['26.2', '26.3']) {
    it(`${version}: applies relative rotation with pitch clamping and immediately echoes false flags`, function () {
      const bot = createBot(version, { serialize: true })
      bot._client.emit('player_rotation', { yaw: 60, pitch: 70, relativeYaw: false, relativePitch: false })
      bot._client.emit('player_rotation', { yaw: 15, pitch: 40, relativeYaw: true, relativePitch: true })
      assert.deepStrictEqual(bot._client.writes.map(packet => packet.name), ['look', 'look'])
      const reply = bot._client.writes[1].params
      assert.strictEqual(reply.yaw, 75)
      assert.strictEqual(reply.pitch, 90)
      assert.strictEqual(reply.flags.onGround, false)
      assert.strictEqual(reply.flags.hasHorizontalCollision, false)
    })
  }

  function correctPosition (bot) {
    bot._client.emit('position', {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 2
    })
    bot.emit('playerLoaded')
  }

  function enablePhysics (bot) {
    bot.inventory = { slots: [] }
    bot.entity.effects = {}
    bot.physics.simulatePlayer = () => ({ apply: () => {} })
    bot.physicsEnabled = true
  }

  it('reports input then sprint then movement in the player sync phase', function () {
    const bot = createBot()
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    assert.deepStrictEqual(bot._client.writes, [])
    bot.entity.position.x = 1
    tick()
    assert.deepStrictEqual(bot._client.writes.map(p => p.name), [
      'player_input', 'entity_action', 'position', 'tick_end'
    ])
    assert.strictEqual(packets(bot, 'entity_action')[0].params.actionId, 'start_sprinting')
    tick()
    assert.strictEqual(packets(bot, 'entity_action').length, 1)
    bot.setControlState('sprint', false)
    tick()
    assert.deepStrictEqual(packets(bot, 'entity_action').map(p => p.params.actionId), [
      'start_sprinting', 'stop_sprinting'
    ])
  })

  it('coalesces sprint press/release and never emits play actions from the setter during configuration', function () {
    const bot = createBot()
    bot.setControlState('sprint', true)
    bot.setControlState('sprint', false)
    tick()
    assert.deepStrictEqual(packets(bot, 'entity_action', 'player_input'), [])
    bot._client.emit('start_configuration')
    bot._client.state = 'configuration'
    bot.setControlState('sprint', true)
    tick()
    assert.deepStrictEqual(packets(bot, 'entity_action', 'player_input'), [])
  })

  it('provides an opt-in synchronous keybinding phase before simulation without moving physicsTick', function () {
    const bot = createBot()
    enablePhysics(bot)
    const phases = []
    bot.physics.simulatePlayer = () => {
      phases.push('simulate')
      return { apply: () => {} }
    }
    bot.on('prePhysicsTick', () => {
      phases.push('prePhysicsTick')
      bot._client.write('test_action', {})
      bot.setControlState('forward', true)
    })
    bot.on('physicsTick', () => { phases.push('physicsTick') })
    bot.on('_playerTick', () => { phases.push('_playerTick') })
    bot.entity.position.x = 1
    tick()
    assert.deepStrictEqual(phases, ['prePhysicsTick', '_playerTick', 'simulate', 'physicsTick'])
    assert.deepStrictEqual(bot._client.writes.map(p => p.name), ['test_action', 'player_input', 'position', 'tick_end'])
  })

  it('stops reporting immediately if a synchronous physics callback enters configuration', function () {
    const bot = createBot()
    enablePhysics(bot)
    bot.on('physicsTick', () => {
      bot._client.emit('start_configuration')
      bot._client.state = 'configuration'
    })
    bot.setControlState('forward', true)
    tick()
    assert.deepStrictEqual(bot._client.writes, [])
  })

  for (const version of ['26.2', '26.3']) {
    it(`sends world tick ends while loading but waits for player readiness on ${version}`, function () {
      const bot = createBot(version, { loaded: false })
      enablePhysics(bot)
      let actions = 0
      bot.on('prePhysicsTick', () => { actions++ })
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      bot.entity.position.x = 1
      tick(3)
      assert.deepStrictEqual(bot._client.writes.map(p => p.name), ['tick_end', 'tick_end', 'tick_end'])
      assert.strictEqual(actions, 0)
      bot.emit('playerLoaded')
      tick()
      assert.strictEqual(actions, 1)
      assert.deepStrictEqual(bot._client.writes.slice(3).map(p => p.name), ['player_input', 'entity_action', 'position', 'tick_end'])
    })

    it(`keeps tick_end while the current column is absent on ${version}`, function () {
      const bot = createBot(version)
      bot.blockAt = () => null
      bot.setControlState('forward', true)
      tick(25)
      assert.strictEqual(packets(bot, 'tick_end').length, 25)
      assert.strictEqual(packets(bot, 'player_input').length, 1)
      assert.deepStrictEqual(packets(bot, 'position').map(p => p.tick), [20])
      bot.blockAt = () => ({})
      tick(15)
      assert.deepStrictEqual(packets(bot, 'position').map(p => p.tick), [20, 40])
    })

    it(`reports passenger look every tick and resumes ground reporting on ${version}`, async function () {
      const bot = createBot(version)
      tick(9)
      bot.vehicle = { id: 2 }
      bot.emit('mount')
      const looking = bot.look(1, 0.4)
      bot.setControlState('sneak', true)
      tick(20)
      await looking
      assert.strictEqual(packets(bot, 'look').length, 20)
      assert.strictEqual(packets(bot, 'tick_end').length, 29)
      assert.deepStrictEqual(packets(bot, 'position', 'position_look', 'entity_action'), [])
      const writes = bot._client.writes.filter(p => p.tick === 10)
      assert.deepStrictEqual(writes.map(p => p.name), ['player_input', 'look', 'tick_end'])
      bot.vehicle = null
      bot.emit('dismount', { id: 2 })
      tick(10)
      assert.deepStrictEqual(packets(bot, 'position', 'position_look'), [])
      tick()
      assert.deepStrictEqual(packets(bot, 'position', 'position_look').map(p => p.tick), [40])
    })

    it(`keeps world tick ends after local death/removal on ${version}`, function () {
      const bot = createBot(version)
      enablePhysics(bot)
      let actions = 0
      bot.on('prePhysicsTick', () => { actions++ })
      tick()
      assert.strictEqual(actions, 1)
      bot.isAlive = false
      bot.emit('death')
      bot.entity.position.x = 1
      tick(30)
      assert.strictEqual(actions, 1)
      assert.strictEqual(packets(bot, 'tick_end').length, 31)
      assert.deepStrictEqual(packets(bot, 'position').map(p => p.tick), [2])
      assert.ok(bot._client.writes.every(p => p.name === 'tick_end' || p.tick < 22))
    })

    it(`stops player sync at the vanilla death-removal phase on ${version}`, function () {
      const bot = createBot(version)
      bot.isAlive = false
      bot.emit('death')
      for (let i = 0; i < 25; i++) {
        bot.entity.position.x++
        tick()
      }
      assert.strictEqual(packets(bot, 'position').length, version === '26.2' ? 20 : 19)
      assert.strictEqual(packets(bot, 'tick_end').length, 25)
    })

    it(`does not reset sendPosition snapshots or reminder for an out-of-tick correction on ${version}`, function () {
      const bot = createBot(version)
      bot.entity.position.x = 1
      tick()
      tick(8)
      bot._client.writes.length = 0
      bot._client.emit('position', {
        x: 1, y: 0, z: 0, yaw: 0, pitch: 0, flags: {}, teleportId: 9
      })
      tick(12)
      assert.deepStrictEqual(packets(bot, 'position').map(p => p.tick), [21])
      assert.strictEqual(packets(bot, 'position_look').length, version === '26.2' ? 1 : 0)
    })

    it(`ticks internal player state while mounted/dead but not loading/removed on ${version}`, function () {
      const bot = createBot(version, { loaded: false })
      let playerTicks = 0
      bot.on('_playerTick', () => { playerTicks++ })
      tick(3)
      assert.strictEqual(playerTicks, 0)
      bot.emit('playerLoaded')
      bot.vehicle = { id: 2 }
      bot.emit('mount')
      tick(3)
      assert.strictEqual(playerTicks, 3)
      bot.isAlive = false
      bot.emit('death')
      tick(30)
      assert.strictEqual(playerTicks, 23)
      bot._client.emit('start_configuration')
      tick(3)
      assert.strictEqual(playerTicks, 23)
    })

    it(`serializes production input/sprint/all movement variants and passenger rotation on ${version}`, async function () {
      const bot = createBot(version, { serialize: true })
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      bot.entity.position.x = 1
      bot.entity.pitch = 0.1
      tick()
      bot.entity.position.x = 2
      tick()
      bot.entity.pitch = 0.2
      tick()
      bot.entity.onGround = true
      bot.entity.isCollidedHorizontally = true
      tick()
      bot.vehicle = { id: 2 }
      bot.emit('mount')
      const looking = bot.look(bot.entity.yaw + 0.2, 0.3)
      tick(10)
      await looking
      assert.deepStrictEqual(bot._client.writes.slice(0, 5).map(p => p.name), [
        'player_input', 'entity_action', 'position_look', 'tick_end', 'position'
      ])
      assert.strictEqual(packets(bot, 'position_look').length, 1)
      assert.strictEqual(packets(bot, 'position').length, 1)
      assert.strictEqual(packets(bot, 'look').length, 11)
      assert.deepStrictEqual(packets(bot, 'flying').map(p => p.params.flags), [
        { _value: 3, onGround: true, hasHorizontalCollision: true }
      ])
      assert.strictEqual(packets(bot, 'tick_end').length, 14)
    })

    it(`acknowledges a passenger correction without applying its transform on ${version}`, function () {
      const bot = createBot(version, { serialize: true })
      bot.entity.position.set(2, 64, 3)
      bot.entity.velocity.set(0.1, 0.2, 0.3)
      bot.entity.yaw = 0.4
      bot.entity.pitch = 0.2
      bot.entity.onGround = true
      bot.vehicle = { id: 2 }
      bot._client.emit('position', {
        x: 99,
        y: 99,
        z: 99,
        yaw: 90,
        pitch: 90,
        dx: 8,
        dy: 8,
        dz: 8,
        flags: {},
        teleportId: 8
      })
      assert.deepStrictEqual(bot.entity.position, new Vec3(2, 64, 3))
      assert.deepStrictEqual(bot.entity.velocity, new Vec3(0.1, 0.2, 0.3))
      assert.strictEqual(bot.entity.yaw, 0.4)
      assert.strictEqual(bot.entity.pitch, 0.2)
      assert.strictEqual(bot.entity.onGround, true)
      const ack = packets(bot, 'teleport_confirm')[0]
      assert.strictEqual(ack.params.teleportId, 8)
      if (version === '26.3') {
        assert.deepStrictEqual(bot._client.writes.map(p => p.name), ['teleport_confirm'])
        assert.strictEqual(ack.params.x, 2)
        assert.strictEqual(ack.params.y, 64)
        assert.strictEqual(ack.params.z, 3)
      } else {
        assert.deepStrictEqual(bot._client.writes.map(p => p.name), ['teleport_confirm', 'position_look'])
        assert.deepStrictEqual(packets(bot, 'position_look')[0].params.flags, {
          _value: 0, onGround: false, hasHorizontalCollision: false
        })
      }
    })

    it(`acknowledges respawn corrections immediately with the vanilla packet sequence on ${version}`, function () {
      const bot = createBot(version, { serialize: true })
      bot.isAlive = false
      bot.emit('death')
      bot.emit('respawn')
      bot._client.emit('position', {
        x: 4,
        y: 64,
        z: -3,
        yaw: 30,
        pitch: -15,
        dx: 0.1,
        dy: 0.2,
        dz: 0.3,
        flags: {},
        teleportId: 12
      })
      assert.deepStrictEqual(bot._client.writes.map(p => p.name), version === '26.3'
        ? ['teleport_confirm']
        : ['teleport_confirm', 'position_look'])
      assert.deepStrictEqual(bot.entity.position, new Vec3(4, 64, -3))
      assert.deepStrictEqual(bot.entity.velocity, new Vec3(0.1, 0.2, 0.3))
      bot.emit('playerLoaded')
      bot.isAlive = true
      tick()
      assert.strictEqual(packets(bot, 'tick_end').length, 1)
    })
  }

  it('does not send tick_end outside an active play world', function () {
    const bot = createBot()
    bot._client.emit('start_configuration')
    tick(3)
    bot._client.state = 'configuration'
    tick(3)
    bot._client.state = 'play'
    tick(3)
    assert.deepStrictEqual(bot._client.writes, [])
    bot.emit('login')
    tick()
    assert.deepStrictEqual(bot._client.writes.map(p => p.name), ['tick_end'])
  })

  it('keeps force look immediate and anchors the next look to the quantized rotation', async function () {
    const bot = createBot()
    await bot.look(1.0007, 0.5007, true)
    assert.deepStrictEqual(bot._client.writes.map(packet => packet.name), ['look'])
    const yaw = bot.entity.yaw
    const pitch = bot.entity.pitch
    await bot.look(yaw, pitch)
    tick()
    const look = packets(bot, 'look')[0]
    assert.ok(look)
    assert.ok(Math.abs(look.params.pitch - (-pitch * 180 / Math.PI)) < 0.001)
    tick()
    assert.strictEqual(packets(bot, 'look').length, 1)
  })

  for (const version of ['26.2', '26.3']) {
    it(`${version}: reports forced aim before an awaited action without resetting the position reminder`, async function () {
      const bot = createBot(version, { serialize: true })
      tick(19)
      bot._client.writes.length = 0
      await bot.look(1, 0.5, true)
      bot._client.write('attack', { entityId: 42 })
      tick()
      assert.deepStrictEqual(bot._client.writes.map(packet => packet.name), ['look', 'attack', 'position', 'tick_end'])
      assert.strictEqual(packets(bot, 'look')[0].params.pitch, Math.fround(-bot.entity.pitch * 180 / Math.PI))
    })

    it(`${version}: gates forced look packets during loading and configuration`, async function () {
      const bot = createBot(version, { loaded: false, serialize: true })
      await bot.look(1, 0.5, true)
      assert.deepStrictEqual(bot._client.writes, [])
      bot.emit('playerLoaded')
      tick()
      assert.strictEqual(packets(bot, 'look').length, 1)
      bot._client.writes.length = 0
      bot._client.emit('start_configuration')
      bot._client.state = 'configuration'
      await bot.look(2, 0.2, true)
      assert.deepStrictEqual(bot._client.writes, [])
    })
  }

  it('preserves the missing-chunk player gate on legacy protocols', function () {
    const bot = createBot('1.18.2')
    bot.blockAt = () => null
    tick(25)
    assert.deepStrictEqual(bot._client.writes, [])
  })

  it('forces an already selected target without waiting for a smooth look', async function () {
    const bot = createBot()
    bot.physics.pitchSpeed = 0.01
    const smooth = bot.look(1, 0.5)
    await bot.look(bot.entity.yaw, bot.entity.pitch, true)
    await smooth
    tick()
    const look = packets(bot, 'look')[0]
    assert.ok(Math.abs(look.params.pitch - (-bot.entity.pitch * 180 / Math.PI)) < 0.001)
  })

  it('keeps superseded look promises fulfilled for shipped API compatibility', async function () {
    const bot = createBot()
    const first = bot.look(1, 0.4)
    const second = bot.look(2, 0.5)
    await first
    tick(20)
    await second
  })

  it('allows awaited looks to schedule an immediate action in the next pre-movement interval', async function () {
    const bot = createBot()
    const action = bot.look(1, 0.4).then(() => { bot._client.write('test_action', {}) })
    tick(20)
    await action
    assert.deepStrictEqual(bot._client.writes.slice(-2).map(p => p.name), ['tick_end', 'test_action'])
    tick()
    assert.strictEqual(bot._client.writes.at(-1).name, 'tick_end')
  })

  it('settles a pending look when a 26.3 correction acknowledges the new rotation', async function () {
    const bot = createBot('26.3')
    const looking = bot.look(1, 0.4)
    correctPosition(bot)
    await looking
    assert.deepStrictEqual(bot._client.writes.map(p => p.name), ['teleport_confirm'])
  })

  for (const copyMetadata of [0, 2]) {
    it(`handles respawn sprint preservation with copyMetadata=${copyMetadata}`, function () {
      const bot = createBot()
      bot.setControlState('sprint', true)
      tick()
      bot._client.writes.length = 0
      bot.emit('respawn')
      bot._client.emit('respawn', { copyMetadata })
      correctPosition(bot)
      tick()
      assert.strictEqual(packets(bot, 'entity_action').length, copyMetadata & 2 ? 0 : 1)
    })
  }

  it('waits for pitch as well as yaw before completing a look', async function () {
    const bot = createBot()
    bot.physics.pitchSpeed = 1
    let completed = false
    const looking = bot.look(bot.entity.yaw, 0.5).then(() => { completed = true })
    tick()
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(completed, false, 'the first packet only turned pitch by 0.05 radians')
    tick(12)
    await looking
    const look = packets(bot, 'look').at(-1)
    assert.ok(Math.abs(look.params.pitch - (-bot.entity.pitch * 180 / Math.PI)) < 0.001)
  })

  it('does not complete a repeated look until the pending rotation is reported', async function () {
    const bot = createBot()
    const first = bot.look(1, 0.5)
    let completed = false
    const second = bot.look(bot.entity.yaw, bot.entity.pitch).then(() => { completed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.strictEqual(completed, false)
    tick(15)
    await Promise.all([first, second])
    assert.strictEqual(completed, true)
  })

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
