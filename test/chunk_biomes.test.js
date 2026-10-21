/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const Module = require('module')
const { Vec3 } = require('vec3')
const protocol = require('minecraft-protocol')
const loadChunk = require('../../prismarine-chunk')
const injectBlocks = require('../lib/plugins/blocks')

function makeBot (version) {
  const bot = new EventEmitter()
  bot.version = version
  bot.registry = require('prismarine-registry')(version)
  bot.protocolVersion = bot.registry.version.version
  bot.supportFeature = bot.registry.supportFeature
  bot.game = { minY: -16, height: 48 }
  bot._client = new EventEmitter()
  // Exercise the source fork even when Mineflayer has an older installed chunk.
  const original = Module._load
  Module._load = function (request, parent, ...args) {
    if (request === 'prismarine-chunk' && parent.filename === require.resolve('../lib/plugins/blocks')) return loadChunk
    return original.call(this, request, parent, ...args)
  }
  try {
    injectBlocks(bot, { version, hideErrors: true })
  } finally {
    Module._load = original
  }
  bot._client.emit('login', { worldState: { dimension: 0, name: 'minecraft:overworld' } })
  const Chunk = loadChunk(bot.registry)
  const source = new Chunk({ minY: -16, worldHeight: 48 })
  for (let y = -16; y < 32; y += 4) {
    for (let z = 0; z < 16; z += 4) {
      for (let x = 0; x < 16; x += 4) source.setBiome(new Vec3(x, y, z), 1 + ((y + 16) >> 4))
    }
  }
  const local = new Vec3(4, -12, 8)
  source.setBlockStateId(local, bot.registry.blocksByName.stone.defaultState)
  bot._client.emit('map_chunk', { x: -3, z: 5, chunkData: source.dump(), blockEntities: [] })
  const column = bot.world.getColumn(-3, 5)
  const serializer = protocol.createSerializer({ version, state: 'play', isServer: true })
  const parser = protocol.createDeserializer({ version, state: 'play', isServer: false, noErrorLogging: true })
  function receive (biomes) {
    const bytes = serializer.createPacketBuffer({ name: 'chunk_biomes', params: { biomes } })
    // ChunkPos is a big-endian long: high 32 bits Z, low 32 bits X.
    const expected = [Buffer.from([0x0d, biomes.length])]
    for (const { position, data } of biomes) {
      assert.ok(data.length < 128)
      const header = Buffer.alloc(9)
      header.writeInt32BE(position.z, 0)
      header.writeInt32BE(position.x, 4)
      header.writeUInt8(data.length, 8)
      expected.push(header, data)
    }
    assert.deepStrictEqual(bytes, Buffer.concat(expected))
    const decoded = parser.parsePacketBuffer(bytes)
    assert.strictEqual(decoded.metadata.size, bytes.length)
    assert.strictEqual(decoded.data.name, 'chunk_biomes')
    bot._client.emit('chunk_biomes', decoded.data.params)
  }
  return { bot, column, local, receive }
}

describe('cached world chunk_biomes packets', function () {
  for (const version of ['26.2', '26.3']) {
    it(`${version}: replaces received biomes and emits world/bot chunk events without replacing block state`, function () {
      const { bot, column, local, receive } = makeBot(version)
      assert.ok(column)
      assert.strictEqual(column.getBiome(local), 1)
      assert.strictEqual(column.getBiome(local.offset(0, 16, 0)), 2)
      const sections = column.sections.slice()
      const blockState = column.getBlockStateId(local)
      let worldEvents = 0
      let botEvents = 0
      let blockEvents = 0
      bot.world.on('chunkColumnLoad', corner => {
        assert.deepStrictEqual([corner.x, corner.y, corner.z], [-48, 0, 80])
        assert.strictEqual(bot.world.getColumn(-3, 5).getBiome(local), 4)
        worldEvents++
      })
      bot.on('chunkColumnLoad', () => { botEvents++ })
      bot.on('blockUpdate', () => { blockEvents++ })
      // Three independently encoded singleton biome containers, bottom to top.
      receive([{ position: { x: -3, z: 5 }, data: Buffer.from([0, 4, 0, 2, 0, 3]) }])
      assert.strictEqual(bot.world.getColumn(-3, 5), column)
      assert.strictEqual(bot.blockAt(new Vec3(-44, -12, 88)).biome.id, 4)
      assert.strictEqual(column.getBiome(local.offset(0, 16, 0)), 2)
      assert.strictEqual(column.getBiome(local.offset(0, 32, 0)), 3)
      assert.strictEqual(column.getBlockStateId(local), blockState)
      for (let i = 0; i < sections.length; i++) assert.strictEqual(column.sections[i], sections[i])
      assert.strictEqual(worldEvents, 1)
      assert.strictEqual(botEvents, 1)
      assert.strictEqual(blockEvents, 0)
    })

    it(`${version}: skips unloaded columns, including malformed unloaded payloads`, function () {
      const { bot, column, local, receive } = makeBot(version)
      let events = 0
      bot.on('chunkColumnLoad', () => { events++ })
      bot.on('error', err => { throw err })
      receive([
        { position: { x: 7, z: -8 }, data: Buffer.alloc(0) },
        { position: { x: -3, z: 5 }, data: Buffer.from([0, 4, 0, 2, 0, 3]) }
      ])
      assert.strictEqual(bot.world.getColumn(7, -8), undefined)
      assert.strictEqual(column.getBiome(local), 4)
      assert.strictEqual(events, 1)
    })

    it(`${version}: emits errors for malformed loaded payloads without partial updates and processes later entries`, function () {
      const { bot, column, local, receive } = makeBot(version)
      const initial = column.biomes
      const errors = []
      let events = 0
      bot.on('error', error => { errors.push(error) })
      bot.on('chunkColumnLoad', () => { events++ })
      receive([{ position: { x: -3, z: 5 }, data: Buffer.from([0, 4, 0, 2, 0]) }])
      assert.strictEqual(errors.length, 1)
      assert.ok(errors[0] instanceof Error)
      assert.strictEqual(column.biomes, initial)
      assert.strictEqual(column.getBiome(local), 1)
      assert.strictEqual(events, 0)
      receive([
        { position: { x: -3, z: 5 }, data: Buffer.from([9]) },
        { position: { x: -3, z: 5 }, data: Buffer.from([0, 4, 0, 2, 0, 3]) }
      ])
      assert.strictEqual(errors.length, 2)
      assert.strictEqual(column.getBiome(local), 4)
      assert.strictEqual(events, 1)
    })
  }
})
