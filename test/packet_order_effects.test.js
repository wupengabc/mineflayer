/* eslint-env mocha */
//
// Regression tests for three production bugs:
//
//   1. Packet ordering: priority writes (attack / arm_animation / keep_alive)
//      must never overtake ordering-sensitive packets (position / position_look
//      / look / flying / teleport_confirm / player_input / tick_end) that were
//      queued earlier. Under socket backpressure the old drain loop flushed
//      the priority queue first, so the server processed attacks against a
//      stale position (anti-cheat kicks) and keepalives ahead of teleports.
//
//   2. Residual velocity: bot.entity.velocity is only decayed inside
//      simulatePlayer. When simulation deactivates (death / mount / respawn /
//      configuration switch / the delayed respawn echo window) the last
//      simulated velocity used to stay frozen forever, which the panel
//      reported as a constant ~1.56 m/s while the bot stood still.
//
//   3. Stale delayed position_look echo: after death the forced teleport echo
//      is delayed by 1500ms. A second forced teleport arriving inside that
//      window used to be followed by the stale first echo, moving the bot
//      backwards in time (movement anti-cheat rubber-band / kick).
//
// Also pins the effect id contract: the wire encodes effect ids as the raw
// 0-based registry id (Speed=0), matching minecraft-data for every supported
// version, so prismarine-physics' getEffectLevel(effects, registryId) keeps
// working and no 1-based id mapping may be reintroduced.

const assert = require('assert')
const EventEmitter = require('events')
const { Client } = require('minecraft-protocol')
const mcData = require('minecraft-data')
const { Vec3 } = require('vec3')

const injectPhysics = require('../lib/plugins/physics')

// ---------------------------------------------------------------------------
// Test 1 — NMP write queue ordering
// ---------------------------------------------------------------------------
describe('nmp write queue ordering', function () {
  function createFakeClient () {
    const client = new Client(false, '26.2')
    const writes = []
    client.ended = false
    client.socket = { writableNeedDrain: false }
    client.framer = { readableLength: 0, readableHighWaterMark: 16 }
    client.serializer = {
      writable: true,
      write (packet) {
        writes.push(packet.name)
        return true
      }
    }
    return { client, writes }
  }

  it('priority packets do not overtake queued movement / tick_end packets', function () {
    const { client, writes } = createFakeClient()
    client.write('position', { x: 1, y: 2, z: 3 })
    client.write('tick_end', {})
    client.writePriority('attack', { entityId: 1 })
    assert.deepStrictEqual(writes, ['position', 'tick_end', 'attack'])
  })

  it('teleport_confirm keeps its place ahead of priority writes', function () {
    const { client, writes } = createFakeClient()
    client.write('teleport_confirm', { teleportId: 7 })
    client.writePriority('arm_animation', {})
    assert.deepStrictEqual(writes, ['teleport_confirm', 'arm_animation'])
  })

  it('keep_alive still jumps over non-sensitive queues', function () {
    const { client, writes } = createFakeClient()
    // Simulate socket backpressure so packets actually accumulate.
    client.socket.writableNeedDrain = true
    client.write('window_click', {})
    client.writePriority('keep_alive', {})
    assert.deepStrictEqual(writes, [], 'nothing may flush while backpressured')
    client.socket.writableNeedDrain = false
    client._drainWriteQueue()
    assert.deepStrictEqual(writes, ['keep_alive', 'window_click'])
  })

  it('movement queued under backpressure still precedes a priority attack', function () {
    const { client, writes } = createFakeClient()
    client.socket.writableNeedDrain = true
    client.write('position', { x: 1, y: 2, z: 3 })
    client.write('tick_end', {})
    client.writePriority('attack', { entityId: 1 })
    client.socket.writableNeedDrain = false
    client._drainWriteQueue()
    assert.deepStrictEqual(writes, ['position', 'tick_end', 'attack'])
  })

  it('priority packets still overtake each other in order when nothing sensitive is queued', function () {
    const { client, writes } = createFakeClient()
    client.writePriority('attack', { entityId: 1 })
    client.write('window_click', {})
    assert.deepStrictEqual(writes, ['attack', 'window_click'])
  })
})

// ---------------------------------------------------------------------------
// Test 2 + 3 — physics plugin: residual velocity & delayed echo race
// ---------------------------------------------------------------------------
describe('physics plugin forced-move handling', function () {
  function createMockBot () {
    const bot = new EventEmitter()
    bot.protocolVersion = 775
    bot.version = '26.2'
    bot.registry = mcData('26.2')
    bot.supportFeature = (name) => ['teleportUsesOwnPacket'].includes(name)
    bot.physicsEnabled = true
    bot.jumpQueued = false
    bot.jumpTicks = 0
    bot.fireworkRocketDuration = 0
    bot.entity = {
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      height: 1.8,
      eyeHeight: 1.62,
      effects: {},
      attributes: {},
      id: 1
    }
    bot.blockAt = () => ({ boundingBox: 'block' }) // chunk always loaded
    bot._client = new EventEmitter()
    bot._client.writes = []
    bot._client.write = (name, params) => { bot._client.writes.push({ name, params }) }

    injectPhysics(bot, { physicsEnabled: true })
    return bot
  }

  function emitForcedTeleport (bot, x, y, z) {
    bot._client.emit('position', {
      x,
      y,
      z,
      yaw: 0,
      pitch: 0,
      flags: {}, // modern bitflags object: all absolute
      teleportId: 1
    })
  }

  it('zeroes residual velocity on death, mount and respawn', function () {
    const bot = createMockBot()
    bot.entity.velocity.set(0.078, 0.1, -0.02)

    bot.emit('death')
    assert.strictEqual(bot.entity.velocity.x + bot.entity.velocity.y + bot.entity.velocity.z, 0,
      'velocity must be zeroed on death')

    bot.entity.velocity.set(0.078, 0, 0)
    bot.emit('mount')
    assert.strictEqual(bot.entity.velocity.x + bot.entity.velocity.y + bot.entity.velocity.z, 0,
      'velocity must be zeroed on mount')

    bot.entity.velocity.set(0, -0.5, 0.03)
    bot.emit('respawn')
    assert.strictEqual(bot.entity.velocity.x + bot.entity.velocity.y + bot.entity.velocity.z, 0,
      'velocity must be zeroed on respawn')
  })

  it('does not flush a stale delayed position_look after a newer forced move', async function () {
    const bot = createMockBot()
    bot.emit('death') // arms respawnTimer

    // First forced teleport inside the death window -> delayed echo (1500ms)
    emitForcedTeleport(bot, 10, 64, 10)
    // Second forced teleport arrives before the delay elapses -> immediate echo
    emitForcedTeleport(bot, 20, 64, 20)

    const positionLooks = bot._client.writes.filter(w => w.name === 'position_look')
    assert.strictEqual(positionLooks.length, 1, 'second teleport must echo immediately')
    assert.strictEqual(positionLooks[0].params.x, 20)
    assert.strictEqual(positionLooks[0].params.z, 20)

    // Let the stale 1500ms timer fire.
    await new Promise(resolve => setTimeout(resolve, 1600))

    const after = bot._client.writes.filter(w => w.name === 'position_look')
    assert.strictEqual(after.length, 1, 'stale delayed echo must be suppressed')
    assert.strictEqual(after[0].params.x, 20, 'only the newest echo may be sent')
  })

  it('still flushes the delayed echo when no newer forced move happens', async function () {
    const bot = createMockBot()
    bot.emit('death')
    emitForcedTeleport(bot, 10, 64, 10)

    const before = bot._client.writes.filter(w => w.name === 'position_look').length
    assert.strictEqual(before, 0, 'echo must be delayed inside the death window')

    await new Promise(resolve => setTimeout(resolve, 1600))

    const after = bot._client.writes.filter(w => w.name === 'position_look')
    assert.strictEqual(after.length, 1, 'delayed echo must still be sent')
    assert.strictEqual(after[0].params.x, 10)
    assert.strictEqual(after[0].params.z, 10)
    assert.strictEqual(bot.entity.velocity.x + bot.entity.velocity.y + bot.entity.velocity.z, 0,
      'velocity must be zeroed while the echo delay holds physics')
  })

  it('teleport_confirm is written before the echoed position_look', function () {
    const bot = createMockBot()
    emitForcedTeleport(bot, 5, 64, 5)
    const names = bot._client.writes.map(w => w.name)
    const confirmIdx = names.indexOf('teleport_confirm')
    const echoIdx = names.indexOf('position_look')
    assert.ok(confirmIdx !== -1 && echoIdx !== -1, 'both packets must be sent')
    assert.ok(confirmIdx < echoIdx, 'teleport_confirm must precede the position_look echo')
  })
})

// ---------------------------------------------------------------------------
// Test 4 — effect id contract (0-based registry ids on the wire)
// ---------------------------------------------------------------------------
describe('entity effect id contract', function () {
  const versions = ['1.20.4', '1.21.11', '26.1', '26.2']

  for (const version of versions) {
    it(`minecraft-data ${version} exposes 0-based effect ids used by the wire`, function () {
      const md = mcData(version)
      assert.strictEqual(md.effectsByName.Speed.id, 0, 'Speed must be registry id 0')
      assert.strictEqual(md.effectsByName.Slowness.id, 1)
      assert.strictEqual(md.effectsByName.Wither.id, 19)
      if (md.effectsByName.BreathOfTheNautilus) {
        assert.strictEqual(md.effectsByName.BreathOfTheNautilus.id, 39)
      }
      // protocol encodes effectId as a raw varint (no +1 offset)
      const effectField = md.protocol.play.toClient.types.packet_entity_effect
      assert.ok(JSON.stringify(effectField).includes('"varint"'),
        'effectId must stay a raw varint (0-based registry id)')
    })
  }

  it('prismarine-physics reads effect levels by registry id (no off-by-one)', function () {
    const { PlayerState } = require('prismarine-physics')
    const bot = {
      version: '26.2',
      entity: {
        position: new Vec3(0, 64, 0),
        velocity: new Vec3(0, 0, 0),
        onGround: true,
        isInWater: false,
        isInLava: false,
        isInWeb: false,
        isCollidedHorizontally: false,
        isCollidedVertically: false,
        elytraFlying: false,
        effects: { 0: { id: 0, amplifier: 1, duration: 100 } } // Speed II
      },
      inventory: { slots: [] },
      jumpTicks: 0,
      jumpQueued: false,
      fireworkRocketDuration: 0
    }
    const state = new PlayerState(bot, {})
    assert.strictEqual(state.speed, 2, 'Speed effect (registry id 0) amplifier 1 -> level 2')
    assert.strictEqual(state.slowness, 0)
  })
})
