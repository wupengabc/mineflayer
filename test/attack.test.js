'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const Vec3 = require('vec3')
const injectEntities = require('../lib/plugins/entities')
const injectInventory = require('../lib/plugins/inventory')
const injectPackets261 = require('../lib/plugins/packets26_1')
const { Client } = require('minecraft-protocol')

function makeBot (version, client = new EventEmitter()) {
  const registry = require('prismarine-registry')(version)
  const bot = new EventEmitter()

  if (!(client instanceof Client)) client.write = (name, params) => bot.writes.push({ name, params })
  bot.writes = []
  bot.version = version
  bot.protocolVersion = registry.version.version
  bot.registry = registry
  bot._client = client
  bot.supportFeature = registry.supportFeature
  bot.getControlState = () => false
  bot.entity = { position: new Vec3(0, 64, 0) }
  bot.world = { getColumnAt: () => ({}) }

  injectEntities(bot)
  injectPackets261(bot)
  return bot
}

function finishLoading (bot) {
  bot.emit('forcedMove')
  bot.emit('chunkColumnLoad')
}

function makeInventoryBot (version) {
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
  bot.lookAt = async () => {}
  bot.swingArm = () => {}

  injectInventory(bot, { hideErrors: false })
  return bot
}

describe('bot.attack', function () {
  it('waits for player_loaded before attacking on 26.1', function () {
    const bot = makeBot('26.1.2')

    bot.attack({ id: 42 })
    assert.deepStrictEqual(bot.writes, [])

    finishLoading(bot)
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
      'player_loaded',
      'attack',
      'arm_animation'
    ])
    assert.deepStrictEqual(bot.writes[1].params, { entityId: 42 })

    bot.emit('chunkColumnLoad')
    assert.strictEqual(bot.writes.filter(packet => packet.name === 'player_loaded').length, 1)
    assert.strictEqual(bot.writes.filter(packet => packet.name === 'attack').length, 1)
  })

  it('waits for player_loaded before attacking on 26.2', function () {
    const bot = makeBot('26.2')

    bot.attack({ id: 42 })
    assert.deepStrictEqual(bot.writes, [])

    finishLoading(bot)
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
      'player_loaded',
      'attack',
      'arm_animation'
    ])

    bot.emit('chunkColumnLoad')
    assert.strictEqual(bot.writes.filter(packet => packet.name === 'player_loaded').length, 1)
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

    finishLoading(bot)
    bot.writes.length = 0
    bot._client.emit('respawn')
    bot.attack({ id: 42 })
    assert.deepStrictEqual(bot.writes, [])

    finishLoading(bot)
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
      'player_loaded',
      'attack',
      'arm_animation'
    ])
  })

  it('resets the load gate after server reconfiguration', function () {
    const bot = makeBot('26.2')

    finishLoading(bot)
    bot.writes.length = 0
    bot._client.emit('start_configuration')
    bot.attack({ id: 42 })
    assert.deepStrictEqual(bot.writes, [])

    finishLoading(bot)
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
      'player_loaded',
      'attack',
      'arm_animation'
    ])
  })

  it('does not replay a burst of attacks queued while loading', function () {
    const bot = makeBot('26.2')
    for (let id = 1; id <= 100; id++) bot.attack({ id })
    finishLoading(bot)
    const attacks = bot.writes.filter(packet => packet.name === 'attack')
    assert.deepStrictEqual(attacks.map(packet => packet.params.entityId), [100])
  })

  it('requires both a server position and the player column before loading', function () {
    const bot = makeBot('26.2')
    bot.world.getColumnAt = () => null
    bot.emit('chunkColumnLoad')
    assert.deepStrictEqual(bot.writes, [])
    bot.emit('forcedMove')
    bot.emit('chunkColumnLoad')
    assert.deepStrictEqual(bot.writes, [])
    bot.world.getColumnAt = () => ({})
    bot.emit('chunkColumnLoad')
    bot.emit('chunkColumnLoad')
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), ['player_loaded'])
  })

  it('drops pending attacks from an earlier load cycle', function () {
    const bot = makeBot('26.2')
    bot.attack({ id: 42 })
    bot._client.emit('respawn')
    finishLoading(bot)
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), ['player_loaded'])
  })

  it('does not attack a target removed while loading', function () {
    const bot = makeBot('26.2')
    const target = { id: 42, isValid: true }
    bot.attack(target)
    target.isValid = false
    finishLoading(bot)
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), ['player_loaded'])
  })

  it('skips attacks during transport pressure and only sends a fresh call after recovery', function () {
    const bot = makeBot('26.2')
    finishLoading(bot)
    bot.writes.length = 0
    bot._client.writeBackpressured = true
    for (let id = 1; id <= 100; id++) bot.attack({ id })
    assert.deepStrictEqual(bot.writes, [])
    bot._client.writeBackpressured = false
    assert.deepStrictEqual(bot.writes, [], 'does not replay skipped attacks')
    bot.attack({ id: 101 })
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), ['attack', 'arm_animation'])
    assert.strictEqual(bot.writes[0].params.entityId, 101)
  })

  it('rechecks pressure before submitting an attack deferred by loading', function () {
    const bot = makeBot('26.2')
    bot.attack({ id: 42 })
    bot._client.writeBackpressured = true
    finishLoading(bot)
    assert.deepStrictEqual(bot.writes.map(packet => packet.name), ['player_loaded'])
  })

  it('prevents an attack backlog with the real protocol queue during a network stall', function () {
    const client = new Client(false, '26.2', undefined, true)
    const writes = []
    client.ended = false
    client.serializer = { writable: true, write: packet => { writes.push(packet); return true } }
    client.socket = { writableNeedDrain: false }
    client.framer = { readableLength: 0, readableHighWaterMark: 16384 }
    const bot = makeBot('26.2', client)
    finishLoading(bot)
    writes.length = 0
    client.socket.writableNeedDrain = true
    client.write('position', { x: 1 })
    for (let id = 1; id <= 100; id++) bot.attack({ id })
    client.write('tick_end', {})
    client.socket.writableNeedDrain = false
    bot.attack({ id: 101 })
    client._drainWriteQueue()
    assert.deepStrictEqual(writes.map(packet => packet.name), ['position', 'tick_end'])
    bot.attack({ id: 102 })
    assert.deepStrictEqual(writes.map(packet => packet.name), ['position', 'tick_end', 'attack', 'arm_animation'])
    assert.strictEqual(writes[2].params.entityId, 102)
  })

  it('invalidates and removes targets before notifying entityGone listeners', function () {
    const bot = makeBot('26.2')
    finishLoading(bot)
    bot.writes.length = 0
    const target = { id: 42, isValid: true, username: 'other' }
    bot.entities[42] = target
    bot.players.other = { entity: target }
    let notified = false
    bot.on('entityGone', entity => {
      notified = true
      assert.strictEqual(entity, target)
      assert.strictEqual(entity.isValid, false)
      assert.strictEqual(bot.entities[42], undefined)
      assert.strictEqual(bot.players.other.entity, null)
      bot.attack(entity)
    })
    bot._client.emit('entity_destroy', { entityIds: [42] })
    assert.strictEqual(notified, true)
    assert.deepStrictEqual(bot.writes, [])
  })
})

describe('bot.interactEntity', function () {
  for (const version of ['26.1.2', '26.2']) {
    it(`sends the fixed main-hand interact layout on ${version}`, function () {
      const bot = makeBot(version)
      bot.interactEntity({ id: 6 })

      assert.deepStrictEqual(bot.writes[0], {
        name: 'use_entity',
        params: {
          target: 6,
          hand: 0,
          location: { x: 0, y: 0, z: 0 },
          sneaking: false
        }
      })
    })
  }

  it('sends main-hand interact-at coordinates on 26.1', function () {
    const bot = makeBot('26.1.2')
    bot.interactEntity({ id: 7, position: new Vec3(10, 64, 10) }, {
      hand: 0,
      position: new Vec3(10, 64.7, 10.25)
    })

    assert.strictEqual(bot.writes[0].name, 'use_entity')
    assert.strictEqual(bot.writes[0].params.target, 7)
    assert.strictEqual(bot.writes[0].params.hand, 0)
    assert.strictEqual(bot.writes[0].params.sneaking, false)
    assert.strictEqual(bot.writes[0].params.location.x, 0)
    assert.ok(Math.abs(bot.writes[0].params.location.y - 0.7) < 1e-9)
    assert.strictEqual(bot.writes[0].params.location.z, 0.25)
  })

  it('sends off-hand interact-at with hand 1', function () {
    const bot = makeBot('26.1.2')
    bot.interactEntity({ id: 8, position: new Vec3(10, 64, 10) }, {
      hand: 1,
      position: new Vec3(10, 64.7, 10.25)
    })

    assert.strictEqual(bot.writes[0].name, 'use_entity')
    assert.strictEqual(bot.writes[0].params.target, 8)
    assert.strictEqual(bot.writes[0].params.hand, 1)
    assert.ok(Math.abs(bot.writes[0].params.location.y - 0.7) < 1e-9)
  })

  it('sends off-hand interact-at with the fixed layout on 26.2', function () {
    const bot = makeBot('26.2')
    bot.interactEntity({ id: 8, position: new Vec3(10, 64, 10) }, {
      hand: 1,
      position: new Vec3(10, 64.7, 10.25)
    })

    assert.strictEqual(bot.writes[0].name, 'use_entity')
    assert.strictEqual(bot.writes[0].params.target, 8)
    assert.strictEqual(bot.writes[0].params.hand, 1)
    assert.deepStrictEqual(Object.keys(bot.writes[0].params).sort(), ['hand', 'location', 'sneaking', 'target'])
    assert.ok(Math.abs(bot.writes[0].params.location.y - 0.7) < 1e-9)
  })

  it('keeps the legacy action-discriminated main-hand layout', function () {
    const bot = makeBot('1.21.11')
    bot.interactEntity({ id: 9 })

    assert.deepStrictEqual(bot.writes[0], {
      name: 'use_entity',
      params: {
        target: 9,
        mouse: 0,
        hand: 0,
        sneaking: false
      }
    })
  })

  it('sends legacy interact-at with explicit hand', function () {
    const bot = makeBot('1.21.11')
    bot.interactEntity({ id: 9, position: new Vec3(10, 64, 10) }, {
      hand: 1,
      position: new Vec3(10, 64.7, 10.25)
    })

    assert.strictEqual(bot.writes[0].name, 'use_entity')
    assert.strictEqual(bot.writes[0].params.mouse, 2)
    assert.strictEqual(bot.writes[0].params.hand, 1)
    assert.strictEqual(bot.writes[0].params.x, 0)
    assert.ok(Math.abs(bot.writes[0].params.y - 0.7) < 1e-9)
    assert.strictEqual(bot.writes[0].params.z, 0.25)
  })
})

describe('bot.activateEntity', function () {
  it('preserves item use on unchanged held-item updates and detects in-place changes', function () {
    const bot = makeInventoryBot('26.2')
    const item = { type: 1, count: 10 }
    bot.emit('heldItemChanged', item)
    bot.usingHeldItem = true
    bot.emit('heldItemChanged', { type: 1, count: 10 })
    bot.emit('heldItemChanged', item)
    assert.strictEqual(bot.usingHeldItem, true)
    item.count--
    bot.emit('heldItemChanged', item)
    assert.strictEqual(bot.usingHeldItem, false)
  })

  it('does not stop using an item when another entity is hurt or dies', function () {
    const bot = makeInventoryBot('26.2')
    bot.entity = { id: 1 }
    bot.usingHeldItem = true
    bot._client.emit('entity_status', { entityId: 2, entityStatus: 3 })
    bot._client.emit('entity_status', { entityId: 2, entityStatus: 9 })
    bot._client.emit('entity_status', { entityId: 1, entityStatus: 2 })
    assert.strictEqual(bot.usingHeldItem, true)
    bot._client.emit('entity_status', { entityId: 1, entityStatus: 9 })
    assert.strictEqual(bot.usingHeldItem, false)
  })

  it('uses the fixed 26.2 layout for a normal right click', async function () {
    const bot = makeInventoryBot('26.2')
    await bot.activateEntity({ id: 11, position: new Vec3(10, 64, 10) })

    assert.deepStrictEqual(bot.writes[0], {
      name: 'use_entity',
      params: {
        target: 11,
        hand: 0,
        location: { x: 0, y: 0, z: 0 },
        sneaking: false
      }
    })
  })

  it('uses the fixed 26.2 layout for an interaction at coordinates', async function () {
    const bot = makeInventoryBot('26.2')
    const entity = { id: 12, position: new Vec3(10, 64, 10) }
    await bot.activateEntityAt(entity, new Vec3(10.25, 64.75, 9.5))

    assert.deepStrictEqual(bot.writes[0], {
      name: 'use_entity',
      params: {
        target: 12,
        hand: 0,
        location: { x: 0.25, y: 0.75, z: -0.5 },
        sneaking: false
      }
    })
  })

  it('keeps the legacy action-discriminated layout', async function () {
    const bot = makeInventoryBot('1.21.11')
    await bot.activateEntity({ id: 13, position: new Vec3(10, 64, 10) })

    assert.deepStrictEqual(bot.writes[0], {
      name: 'use_entity',
      params: {
        target: 13,
        mouse: 0,
        sneaking: false,
        hand: 0
      }
    })
  })
})
