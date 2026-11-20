/* eslint-env mocha */
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { createSerializer, createDeserializer } = require('minecraft-protocol')
const injectBlocks = require('../lib/plugins/blocks')

function makeWorld () {
  const bot = new EventEmitter()
  bot.version = '26.3'
  bot.registry = require('prismarine-registry')(bot.version)
  bot.protocolVersion = bot.registry.version.version
  bot.supportFeature = bot.registry.supportFeature
  bot._client = new EventEmitter()
  injectBlocks(bot, {})
  bot._client.emit('login', { worldState: { dimension: 0, name: 'test:first' } })
  const Chunk = require('prismarine-chunk')(bot.registry)
  bot.world.setColumn(-3, 5, new Chunk({ minY: -64, worldHeight: 384 }))
  return bot
}

describe('dense block updates', function () {
  it('applies decoded 26.3 section changes in order without extra ordinary block reads', function () {
    const bot = makeWorld()
    const stone = bot.registry.blocksByName.stone.defaultState
    const dirt = bot.registry.blocksByName.dirt.defaultState
    const point = new Vec3(-44, -12, 88)
    const next = point.offset(1, 0, 0)
    const serializer = createSerializer({ version: bot.version, state: 'play', isServer: true })
    const parser = createDeserializer({ version: bot.version, state: 'play', isServer: false })
    const bytes = serializer.createPacketBuffer({ name: 'multi_block_change', params: {
      chunkCoordinates: { x: -3, y: -1, z: 5 }, records: [(stone << 12) | 0x484, (dirt << 12) | 0x584, (dirt << 12) | 0x484]
    } })
    const packet = parser.parsePacketBuffer(bytes)
    assert.strictEqual(packet.metadata.size, bytes.length)
    const events = []
    bot.on('blockUpdate', (_, changed) => events.push([changed.position, changed.stateId]))
    let reads = 0
    const getBlock = bot.world.getBlock.bind(bot.world)
    bot.world.getBlock = p => { reads++; return getBlock(p) }
    bot._client.emit(packet.data.name, packet.data.params)
    assert.strictEqual(reads, 0)
    assert.deepStrictEqual(events, [[point, stone], [next, dirt], [point, dirt]])
    assert.strictEqual(bot.blockAt(point).stateId, dirt)
    assert.strictEqual(bot.blockAt(next).stateId, dirt)
  })

  it('keeps a tracked painting on a same-type update and removes it after a type change', function () {
    const bot = makeWorld()
    const point = new Vec3(-44, -12, 88)
    const { stone, dirt } = bot.registry.blocksByName
    bot.world.setBlockStateId(point, stone.defaultState)
    bot._client.emit('spawn_entity_painting', { entityId: 1, location: point, title: 'test', direction: 0 })
    const painting = bot.blockAt(point).painting
    assert.ok(painting)
    bot._client.emit('block_change', { location: point, type: stone.defaultState })
    assert.strictEqual(bot.blockAt(point).painting, painting)
    bot._client.emit('block_change', { location: point, type: dirt.defaultState })
    assert.strictEqual(bot.blockAt(point).painting, undefined)
    // Updates before a column arrives still do not throw.
    bot._client.emit('block_change', { location: point.offset(16, 0, 0), type: dirt.defaultState })
  })

  it('unloads old columns on a same-dimension-type world change, not a same-world respawn', function () {
    const bot = makeWorld()
    const original = bot.world.getColumn(-3, 5)
    bot._client.emit('respawn', { worldState: { dimension: 0, name: 'test:first' } })
    assert.strictEqual(bot.world.getColumn(-3, 5), original)
    bot._client.emit('respawn', { worldState: { dimension: 0, name: 'test:second' }, copyMetadata: true })
    assert.strictEqual(bot.world.getColumn(-3, 5), undefined)
    assert.strictEqual(bot._getDimensionName(), 'test:second')
  })
})
