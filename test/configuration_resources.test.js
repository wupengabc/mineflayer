/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const protocol = require('minecraft-protocol')
const nbt = require('prismarine-nbt')
const injectGame = require('../lib/plugins/game')
const injectResourcePack = require('../lib/plugins/resource_pack')

const uuid = '01234567-89ab-cdef-0123-456789abcdef'
const anotherUUID = '11234567-89ab-cdef-0123-456789abcdef'

function createBot (version, state = 'configuration') {
  const bot = new EventEmitter()
  bot.registry = require('prismarine-registry')(version)
  bot.supportFeature = bot.registry.supportFeature
  bot._client = new EventEmitter()
  bot._client.state = state
  bot._client.registerChannel = () => {}
  bot.channels = []
  bot._client.writeChannel = (...args) => bot.channels.push(args)
  bot.writes = []
  const codecs = new Map()
  function codec (state, isServer) {
    const key = `${state}/${isServer}`
    if (!codecs.has(key)) {
      codecs.set(key, {
        writer: protocol.createSerializer({ version, state, isServer }),
        reader: protocol.createDeserializer({ version, state, isServer: !isServer, noErrorLogging: true })
      })
    }
    return codecs.get(key)
  }
  function roundtrip (name, params, isServer) {
    const { writer, reader } = codec(bot._client.state, isServer)
    const bytes = writer.createPacketBuffer({ name, params })
    const decoded = reader.parsePacketBuffer(bytes)
    assert.strictEqual(decoded.metadata.size, bytes.length, `${name}: full wire consumption`)
    return decoded.data
  }
  bot._client.write = (name, params) => bot.writes.push(roundtrip(name, params, false))
  bot.receive = (name, params) => {
    const decoded = roundtrip(name, params, true)
    bot._client.emit(decoded.name, decoded.params)
  }
  bot.configure = () => {
    const oldState = bot._client.state
    bot._client.state = 'configuration'
    bot._client.emit('state', 'configuration', oldState)
  }
  // Mimic the protocol's pre-existing completion listener. Game must commit
  // before this listener observes the registry and changes packet codecs.
  bot._client.on('finish_configuration', () => { bot._client.state = 'play' })
  injectGame(bot, { brand: 'test' })
  injectResourcePack(bot)
  return bot
}

function pack (id = uuid) {
  return { uuid: id, url: 'https://example.com/pack.zip', hash: '', forced: false }
}

function dimension (key, minY = -64, height = 384) {
  return { key, value: nbt.comp({ min_y: nbt.int(minY), height: nbt.int(height) }) }
}

function tags (tagType, name, entries) {
  return { tags: [{ tagType, tags: [{ tagName: name, entries }] }] }
}

describe('configuration resource lifecycle with raw plugin codecs', function () {
  for (const version of ['26.2', '26.3']) {
    it(`${version}: callback denial sends exactly one UUID decline and never acceptance`, function () {
      const bot = createBot(version)
      bot.on('resourcePack', (url, id) => {
        assert.strictEqual(url, pack().url)
        assert.strictEqual(id, uuid)
        bot.denyResourcePack()
        bot.acceptResourcePack()
      })
      bot.receive('add_resource_pack', pack())
      bot.denyResourcePack()
      assert.deepStrictEqual(bot.writes, [{ name: 'resource_pack_receive', params: { uuid, result: 1 } }])
    })

    it(`${version}: receiving a pack never asserts acceptance or successful loading`, function () {
      const bot = createBot(version)
      bot.receive('add_resource_pack', pack())
      assert.deepStrictEqual(bot.writes, [])
      bot._client.state = 'play'
      bot.receive('add_resource_pack', pack(anotherUUID))
      assert.deepStrictEqual(bot.writes, [])
    })

    it(`${version}: preserves explicit acceptance semantics and prevents duplicate decisions`, function () {
      const bot = createBot(version)
      bot.on('resourcePack', () => { bot.acceptResourcePack(); bot.acceptResourcePack(); bot.denyResourcePack() })
      bot.receive('add_resource_pack', pack())
      assert.deepStrictEqual(bot.writes.map(packet => packet.params), [{ uuid, result: 3 }, { uuid, result: 0 }])
    })

    it(`${version}: removed packs cannot be answered by a delayed callback`, function () {
      const bot = createBot(version)
      bot.receive('add_resource_pack', pack())
      bot.receive('remove_resource_pack', { uuid })
      bot.acceptResourcePack()
      bot.receive('add_resource_pack', pack(anotherUUID))
      bot.receive('remove_resource_pack', {})
      bot.denyResourcePack()
      assert.deepStrictEqual(bot.writes, [])
    })

    it(`${version}: appends split registry segments and commits before the finish handler`, function () {
      const bot = createBot(version)
      bot.receive('registry_data', { id: 'minecraft:dimension_type', entries: [dimension('minecraft:overworld')] })
      bot.receive('registry_data', { id: 'custom:registry', entries: [{ key: 'custom:raw', value: nbt.comp({ value: nbt.int(42) }) }] })
      bot.receive('registry_data', { id: 'minecraft:dimension_type', entries: [dimension('custom:moon', 0, 128)] })
      let committed
      bot._client.on('finish_configuration', () => { committed = bot.registry.dimensionsById[1] })
      bot.receive('finish_configuration', {})
      assert.strictEqual(committed.name, 'custom:moon')
      assert.strictEqual(bot.registry.dimensionsById[0].minY, -64)
      assert.strictEqual(bot.registry.dimensionsById[1].height, 128)
      assert.strictEqual(bot.registry.registries['minecraft:dimension_type'].entries.length, 2)
      assert.strictEqual(nbt.simplify(bot.registry.registries['custom:registry'].entries[0].value).value, 42)
    })

    it(`${version}: retains registry identity for tags-only reconfiguration and replaces tags per registry`, function () {
      const bot = createBot(version)
      bot.receive('registry_data', { id: 'minecraft:dimension_type', entries: [dimension('minecraft:overworld')] })
      bot.receive('tags', tags('minecraft:block', 'custom:first', [1, 2]))
      bot.receive('tags', tags('minecraft:item', 'custom:items', [3]))
      bot.receive('feature_flags', { features: ['minecraft:vanilla', 'custom:feature'] })
      bot.receive('finish_configuration', {})
      const dimensions = bot.registry.dimensionsById
      const registries = bot.registry.registries
      bot.configure()
      bot.receive('tags', tags('minecraft:block', 'custom:old', [4]))
      bot.receive('tags', tags('minecraft:block', 'custom:new', [5]))
      bot.receive('finish_configuration', {})
      assert.strictEqual(bot.registry.dimensionsById, dimensions)
      assert.strictEqual(bot.registry.registries, registries)
      assert.deepStrictEqual(bot.registry.tags['minecraft:block'], [{ tagName: 'custom:new', entries: [5] }])
      assert.deepStrictEqual(bot.registry.tags['minecraft:item'], [{ tagName: 'custom:items', entries: [3] }])
      assert.deepStrictEqual(bot.game.enabledFeatures, ['minecraft:vanilla', 'custom:feature'])
      bot.receive('tags', tags('minecraft:item', 'custom:play', [8]))
      assert.deepStrictEqual(bot.registry.tags['minecraft:item'], [{ tagName: 'custom:play', entries: [8] }])
    })

    it(`${version}: preserves biome and chat IDs across split segments`, function () {
      const bot = createBot(version)
      const biome = key => ({ key, value: nbt.comp({ temperature: nbt.float(0.5), downfall: nbt.float(0.25) }) })
      const chat = key => ({
        key,
        value: nbt.comp({ chat: nbt.comp({ translation_key: nbt.string(key), parameters: nbt.list(nbt.string(['sender', 'content'])) }) })
      })
      bot.receive('registry_data', { id: 'minecraft:worldgen/biome', entries: [biome('custom:first')] })
      bot.receive('registry_data', { id: 'minecraft:chat_type', entries: [chat('custom:first')] })
      bot.receive('registry_data', { id: 'minecraft:worldgen/biome', entries: [biome('custom:second')] })
      bot.receive('registry_data', { id: 'minecraft:chat_type', entries: [chat('custom:second')] })
      bot.receive('finish_configuration', {})
      assert.strictEqual(bot.registry.biomes[0].name, 'custom:first')
      assert.strictEqual(bot.registry.biomes[1].name, 'custom:second')
      const offset = bot.supportFeature('incrementedChatType') ? 1 : 0
      assert.strictEqual(bot.registry.chatFormattingById[offset].name, 'custom:first')
      assert.strictEqual(bot.registry.chatFormattingById[offset + 1].name, 'custom:second')
    })

    it(`${version}: discards an interrupted configuration collector on a new generation`, function () {
      const bot = createBot(version)
      bot.receive('registry_data', { id: 'minecraft:dimension_type', entries: [dimension('custom:abandoned')] })
      bot.receive('tags', tags('minecraft:block', 'custom:abandoned', [1]))
      bot.receive('feature_flags', { features: ['custom:abandoned'] })
      bot.configure()
      bot.receive('registry_data', { id: 'minecraft:dimension_type', entries: [dimension('custom:current')] })
      bot.receive('finish_configuration', {})
      assert.deepStrictEqual(bot.registry.dimensionsArray.map(d => d.name), ['custom:current'])
      assert.deepStrictEqual(Object.keys(bot.registry.tags), [])
      assert.strictEqual(bot.game.enabledFeatures, undefined)
    })

    it(`${version}: starts new contents at ID zero and removes stale registry/tag data`, function () {
      const bot = createBot(version)
      bot.receive('registry_data', { id: 'minecraft:dimension_type', entries: [dimension('minecraft:overworld')] })
      bot.receive('registry_data', { id: 'custom:old', entries: [] })
      bot.receive('tags', tags('minecraft:block', 'custom:old', [1]))
      bot.receive('finish_configuration', {})
      bot.configure()
      bot.receive('registry_data', { id: 'minecraft:dimension_type', entries: [dimension('custom:new', 16, 256)] })
      bot.receive('feature_flags', { features: [] })
      bot.receive('finish_configuration', {})
      assert.strictEqual(bot.registry.dimensionsArray.length, 1)
      assert.strictEqual(bot.registry.dimensionsById[0].name, 'custom:new')
      assert.strictEqual(bot.registry.dimensionsByName.overworld, undefined)
      assert.strictEqual(bot.registry.registries['custom:old'], undefined)
      assert.deepStrictEqual(Object.keys(bot.registry.tags), [])
      assert.deepStrictEqual(bot.game.enabledFeatures, [])
    })

    it(`${version}: retains missing optional values raw without crashing or shifting IDs`, function () {
      const bot = createBot(version)
      bot.receive('registry_data', {
        id: 'minecraft:dimension_type',
        entries: [{ key: 'custom:unknown' }, dimension('custom:known')]
      })
      bot.receive('registry_data', { id: 'custom:unknown', entries: [{ key: 'custom:raw' }] })
      bot.receive('finish_configuration', {})
      assert.deepStrictEqual(bot.registry.dimensionsArray, [])
      assert.strictEqual(bot.registry.registries['minecraft:dimension_type'].entries[1].key, 'custom:known')
      assert.strictEqual(bot.registry.registries['custom:unknown'].entries[0].value, undefined)
    })

    it(`${version}: leaves configuration ping to NMP and replies once in play`, function () {
      const bot = createBot(version)
      bot.receive('ping', { id: 42 })
      assert.deepStrictEqual(bot.writes, [])
      bot.receive('finish_configuration', {})
      bot.receive('ping', { id: 43 })
      assert.deepStrictEqual(bot.writes, [{ name: 'pong', params: { id: 43 } }])
    })

    it(`${version}: does not duplicate the initial configuration brand on play login`, function () {
      const bot = createBot(version)
      bot.receive('registry_data', { id: 'minecraft:dimension_type', entries: [dimension('minecraft:overworld')] })
      bot.receive('finish_configuration', {})
      bot._client.emit('login', { worldState: { dimension: 'minecraft:overworld', gamemode: 'survival' } })
      assert.deepStrictEqual(bot.channels, [])
    })
  }

  it('1.20.2: resource_pack_send callback can decline once during configuration', function () {
    const bot = createBot('1.20.2')
    bot.on('resourcePack', (url, hash) => {
      assert.strictEqual(url, pack().url)
      assert.strictEqual(hash, '')
      bot.denyResourcePack()
    })
    bot.receive('resource_pack_send', pack())
    assert.deepStrictEqual(bot.writes[0].params, { result: 1 })
    assert.strictEqual(bot.writes.length, 1)
  })

  it('1.9: declines hash packs with their hash and retains legacy game brand', function () {
    const bot = createBot('1.9', 'play')
    const hash = 'a'.repeat(40)
    bot.on('resourcePack', () => bot.denyResourcePack())
    bot.receive('resource_pack_send', { url: pack().url, hash })
    assert.deepStrictEqual(bot.writes[0].params, { hash, result: 1 })
    bot._client.emit('login', { dimension: 0, gameMode: 0 })
    assert.deepStrictEqual(bot.channels, [['MC|Brand', 'test']])
  })
})
