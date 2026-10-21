'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const { createRequire } = require('module')
const { Vec3 } = require('vec3')
const { getNextSequence } = require('../lib/interaction_sequence')
const injectInventory = require('../lib/plugins/inventory')
const injectDigging = require('../lib/plugins/digging')
const injectGenericPlace = require('../lib/plugins/generic_place')
const injectPlaceEntity = require('../lib/plugins/place_entity')

// Also exercise the deployed application's codec/data without changing installs.
const runtimeRequire = process.env.MINEFLAYER_TEST_RUNTIME
  ? createRequire(process.env.MINEFLAYER_TEST_RUNTIME)
  : require
const protocol = runtimeRequire(process.env.MINEFLAYER_TEST_RUNTIME ? '@wp2508/minecraft-protocol' : 'minecraft-protocol')
const minecraftData = runtimeRequire(process.env.MINEFLAYER_TEST_RUNTIME ? '@wp2508/minecraft-data' : 'minecraft-data')

function fixture (version = '26.2') {
  const bot = new EventEmitter()
  bot.version = version
  bot.registry = minecraftData(version)
  bot.protocolVersion = bot.registry.version.version
  bot.supportFeature = name => bot.registry.supportFeature(name)
  bot.world = {}
  let level = 'minecraft:overworld'
  bot._getDimensionName = () => level
  bot._client = new EventEmitter()
  bot._client.on('login', packet => { level = packet.worldState?.name ?? packet.worldName })
  bot._client.on('respawn', packet => { level = packet.worldState?.name ?? packet.worldName })
  const serializer = protocol.createSerializer({ state: 'play', version, isServer: false })
  const deserializer = protocol.createDeserializer({ state: 'play', version, isServer: true })
  bot.writes = []
  bot._client.write = (name, params) => {
    const bytes = serializer.createPacketBuffer({ name, params })
    const parsed = deserializer.parsePacketBuffer(bytes)
    assert.strictEqual(parsed.metadata.size, bytes.length)
    bot.writes.push({ ...parsed.data, bytes, original: params })
  }
  bot.entity = { position: new Vec3(0, 64, 0), yaw: Math.PI / 2, pitch: -Math.PI / 6 }
  bot.lookAt = async () => {}
  bot.swingArm = () => {}
  bot.QUICK_BAR_START = 36
  injectInventory(bot, {})
  injectDigging(bot)
  injectGenericPlace(bot)
  injectPlaceEntity(bot)
  bot.quickBarSlot = 0
  const Item = require('prismarine-item')(bot.registry)
  bot.inventory.slots[36] = new Item(bot.registry.itemsByName.oak_boat.id, 1)
  bot.inventory.slots[45] = bot.heldItem
  bot.digTime = () => 25
  bot._updateBlockState = position => bot.emit(`blockUpdate:${position}`, {}, { type: 0 })
  return { bot, serializer, block: { position: new Vec3(0, 64, -1) }, face: new Vec3(0, 1, 0) }
}

async function withTimers (run) {
  const originals = [global.setTimeout, global.clearTimeout, global.setInterval, global.clearInterval]
  const timers = new Map()
  global.setTimeout = (callback, delay) => {
    const timer = {}
    timers.set(timer, { callback, delay })
    return timer
  }
  global.clearTimeout = timer => timers.delete(timer)
  global.setInterval = () => ({})
  global.clearInterval = () => {}
  try {
    await run(delay => {
      const entry = [...timers].find(([, timer]) => timer.delay === delay)
      assert.ok(entry, `expected a ${delay}ms timer`)
      timers.delete(entry[0])
      entry[1].callback()
    })
  } finally {
    [global.setTimeout, global.clearTimeout, global.setInterval, global.clearInterval] = originals
  }
}

describe('shared interaction prediction sequence', function () {
  for (const version of ['26.2', '26.3']) {
    it(`${version}: shares one wire sequence across item use, digging, block use, placement and boats`, async function () {
      await withTimers(async fire => {
        const { bot, block, face } = fixture(version)
        bot.activateItem()
        const dig = bot.dig(block, 'ignore')
        await bot._genericPlace(block, face, { forceLook: 'ignore' })
        await bot.activateBlock(block, face, undefined, 'ignore')
        const boat = bot._placeEntityWithOptions(block, face, { forceLook: 'ignore', offhand: true })
        await Promise.resolve()
        bot.emit('entitySpawn', { name: 'boat', position: block.position.plus(face) })
        await boat
        fire(25)
        await dig
        bot.deactivateItem()

        assert.deepStrictEqual(bot.writes.map(({ name, params }) => [name, params.sequence]), [
          ['use_item', 1], ['block_dig', 2], ['block_place', 3], ['block_place', 4],
          ['block_place', 5], ['use_item', 6], ['block_dig', 7], ['block_dig', 0]
        ])
        assert.deepStrictEqual(bot.writes.filter(p => p.name === 'block_dig').map(p => p.params.status), version === '26.3' ? [0, 3, 6] : [0, 2, 5])
        const place = bot.writes[2].params
        const hit = version === '26.3' ? place.hitResult : place
        assert.deepStrictEqual(hit.location, { x: 0, y: 64, z: -1 })
        assert.strictEqual(hit.direction, 1)
        assert.strictEqual(hit.cursorY, 1)
        assert.strictEqual(hit.worldBorderHit, false)
        const useBoat = bot.writes[5].params
        assert.strictEqual(useBoat.hand, 1)
        assert.strictEqual(useBoat.rotation.x, 90)
        assert.strictEqual(useBoat.rotation.y, 30)
        bot.activateItem()
        assert.strictEqual(bot.writes.at(-1).params.sequence, 8)
      })
    })

    it(`${version}: keeps abort and release at zero without consuming prediction IDs`, async function () {
      await withTimers(async () => {
        const { bot, block } = fixture(version)
        const digging = bot.dig(block, 'ignore')
        const aborted = assert.rejects(digging, /Digging aborted/)
        bot.stopDigging()
        await aborted
        bot.deactivateItem()
        bot.activateItem()
        assert.deepStrictEqual(bot.writes.map(p => [p.params.status, p.params.sequence]), [
          [0, 1], [version === '26.3' ? 2 : 1, 0], [version === '26.3' ? 6 : 5, 0], [undefined, 2]
        ])
      })
    })
  }

  it('resets for new levels/login/configuration, preserving same-world respawn, teleport and acknowledgements', function () {
    const { bot } = fixture()
    bot.activateItem()
    bot._client.emit('respawn', { worldState: { name: 'minecraft:overworld', dimension: 0 } })
    bot.activateItem()
    bot._client.emit('position', { teleportId: 8 })
    bot._client.emit('acknowledge_player_digging', { sequenceId: 2 })
    bot.activateItem()
    assert.deepStrictEqual(bot.writes.map(p => p.params.sequence), [1, 2, 3])

    // Worlds may share a dimension TYPE ID; their level names still differ.
    bot._client.emit('respawn', { worldState: { name: 'custom:second_world', dimension: 0 }, copyMetadata: true })
    bot.activateItem()
    assert.strictEqual(bot.writes.at(-1).params.sequence, 1)
    bot._client.emit('start_configuration', {})
    bot.activateItem()
    assert.strictEqual(bot.writes.at(-1).params.sequence, 1)
    bot._client.emit('login', { worldState: { name: 'custom:second_world' } })
    bot.activateItem()
    assert.strictEqual(bot.writes.at(-1).params.sequence, 1)
    bot.world = {}
    bot.activateItem()
    assert.strictEqual(bot.writes.at(-1).params.sequence, 1)
  })

  it('resets before public lifecycle listeners can send another predictive action', function () {
    const { bot } = fixture()
    bot._client.on('login', () => bot.activateItem())
    bot.activateItem()
    bot.activateItem()
    bot._client.emit('login', { worldState: { name: 'minecraft:overworld' } })
    assert.deepStrictEqual(bot.writes.map(p => p.params.sequence), [1, 2, 1])
  })

  it('shares predictions since 1.19 and tracks pre-1.20.5 worldName lifecycle packets', async function () {
    const { bot, block, face } = fixture('1.19')
    bot.activateItem()
    await bot._genericPlace(block, face, { forceLook: 'ignore' })
    bot._client.emit('respawn', { worldName: 'minecraft:overworld' })
    bot.activateItem()
    bot._client.emit('respawn', { worldName: 'minecraft:the_nether' })
    bot.activateItem()
    assert.deepStrictEqual(bot.writes.map(p => p.params.sequence), [1, 2, 3, 1])
  })

  it('uses independent bots and attaches lifecycle listeners only once', function () {
    const { bot: a } = fixture()
    const { bot: b } = fixture()
    const counts = ['login', 'respawn', 'start_configuration'].map(event => a._client.listenerCount(event))
    for (let i = 1; i <= 20; i++) assert.strictEqual(getNextSequence(a), i)
    assert.strictEqual(getNextSequence(b), 1)
    assert.strictEqual(getNextSequence(a), 21)
    assert.deepStrictEqual(['login', 'respawn', 'start_configuration'].map(event => a._client.listenerCount(event)), counts.map(n => n + 1))
  })

  it('preserves pre-1.19 packet bytes without adding a predictor', async function () {
    await withTimers(async fire => {
      const { bot, serializer, block, face } = fixture('1.18.2')
      const counts = ['login', 'respawn', 'start_configuration'].map(event => bot._client.listenerCount(event))
      bot.activateItem()
      const dig = bot.dig(block, 'ignore')
      await bot._genericPlace(block, face, { forceLook: 'ignore' })
      fire(25)
      await dig
      for (const packet of bot.writes) {
        const original = { ...packet.original }
        delete original.sequence
        delete original.rotation
        assert.deepStrictEqual(packet.bytes, serializer.createPacketBuffer({ name: packet.name, params: original }))
        assert.ok(!Object.hasOwn(packet.params, 'sequence'))
      }
      assert.deepStrictEqual(['login', 'respawn', 'start_configuration'].map(event => bot._client.listenerCount(event)), counts)
    })
  })
})
