'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const protocol = require('minecraft-protocol')
const minecraftData = require('minecraft-data')
const injectCreative = require('../lib/plugins/creative')

const text = value => ({ type: 'string', value })
const messages = ['a', 'b', 'c', 'd'].map(text)
const filteredMessages = ['e', 'f', 'g', 'h'].map(text)
const constant = value => ({ isConstant: true, value })
const key = value => ({ isConstant: false, value })

// Expected bytes follow Mojmap26.3 DataComponents and each component's STREAM_CODEC.
// NBT string tags include a u16 byte length; SignText fixedSizeList(4) has no count.
const rawMessages = '08000161080001620800016308000164'
const rawFiltered = '08000165080001660800016708000168'
const newComponents = [
  ['attack_animation', { type: 'whack', duration: 130 }, '28018201'],
  ['interact_animation', { type: 'stab', duration: 7 }, '290207'],
  ['block_transformer', 300, '2bac02'],
  ['villager_food', { nutrition: 128 }, '2c8001'],
  ['compostable', { layers: constant(300) }, '54010000012c'],
  ['compostable', { layers: key('minecraft:x') }, '54000b6d696e6563726166743a78'],
  ['cooking_fuel', { burnTime: constant(1600), speedMultiplier: constant(1.5) }, '550100000640013fc00000'],
  ['cooking_fuel', { burnTime: key('minecraft:x'), speedMultiplier: key('minecraft:y') }, '55000b6d696e6563726166743a78000b6d696e6563726166743a79'],
  ['brewing_fuel', { uses: constant(20), speedMultiplier: constant(0.5) }, '560100000014013f000000'],
  ['brewing_fuel', { uses: key('minecraft:x'), speedMultiplier: key('minecraft:y') }, '56000b6d696e6563726166743a78000b6d696e6563726166743a79'],
  ['mob_visibility', { targetingEntityTypes: { ids: [2, 300] }, visibility: 0.5 }, '570302ac023f000000'],
  ['mob_visibility', { targetingEntityTypes: { name: 'minecraft:x' }, visibility: 1 }, '57000b6d696e6563726166743a783f800000'],
  ['provides_pottery_pattern', 300, '75ac02'],
  ['sign_text_front', { messages, filteredMessages: undefined, color: 'black', hasGlowingText: true }, `76${rawMessages}000f01`],
  ['sign_text_back', { messages, filteredMessages, color: 'red', hasGlowingText: false }, `77${rawMessages}01${rawFiltered}0e00`],
  ['waxed', undefined, '78'],
  ['cushion/color', 'blue', '790b']
]
const template = {
  itemId: 300,
  itemCount: 2,
  addedComponentCount: 1,
  removedComponentCount: 1,
  components: [{ type: 'damage', data: 128 }],
  removeComponents: [{ type: 'custom_name' }]
}
const rawTemplate = 'ac0202010103800106'

function codecs (version, compiled = true) {
  const serializer = protocol.createSerializer({ version, state: 'play', compiled })
  const deserializer = protocol.createDeserializer({ version, state: 'play', isServer: true, compiled })
  return { serializer, deserializer, proto: serializer.proto }
}

function expectComponent (proto, type, data, hex) {
  const bytes = Buffer.from(hex, 'hex')
  assert.deepStrictEqual(proto.createPacketBuffer('SlotComponent', { type, data }), bytes)
  const parsed = proto.parsePacketBuffer('SlotComponent', bytes)
  assert.strictEqual(parsed.metadata.size, bytes.length)
  assert.deepStrictEqual(parsed.data, { type, data })
}

function creativeFixture (version, compiled = true, liveSerializer = true) {
  const bot = new EventEmitter()
  bot.version = version
  bot.registry = minecraftData(version)
  bot.protocolVersion = bot.registry.version.version
  bot.supportFeature = () => false
  bot.inventory = new EventEmitter()
  bot.inventory.slots = Array(46).fill(null)
  const { serializer, deserializer } = codecs(version, compiled)
  bot._client = { serializer: liveSerializer ? serializer : undefined }
  const writes = []
  bot._client.write = (name, params) => {
    const bytes = serializer.createPacketBuffer({ name, params })
    const parsed = deserializer.parsePacketBuffer(bytes)
    assert.strictEqual(parsed.metadata.size, bytes.length)
    writes.push({ bytes, params: parsed.data.params })
    queueMicrotask(() => bot.inventory.emit(`updateSlot:${params.slot}`, null, currentItem))
  }
  let currentItem
  injectCreative(bot)
  const Item = require('prismarine-item')(bot.registry)
  return {
    bot,
    Item,
    writes,
    async set (item) {
      currentItem = item
      await bot.creative.setInventorySlot(36, item)
    }
  }
}

describe('component payload wire parity', function () {
  it('has exactly one dispatch case for all 122 registered26.3 components in both copies', function () {
    const canonical = require('../../minecraft-data/data/pc/26.3/protocol.json').types
    const embedded = require('../../node-minecraft-data/minecraft-data/data/pc/26.3/protocol.json').types
    const fields = canonical.SlotComponent[1][1].type[1].fields
    const registered = Object.values(canonical.SlotComponentType[1].mappings)
    assert.strictEqual(registered.length, 122)
    assert.strictEqual(Object.keys(fields).length, 122)
    assert.deepStrictEqual(Object.keys(fields).sort(), registered.sort())
    for (const name of ['SlotComponent', 'ResolvableInt', 'ResolvableFloat', 'SignText']) {
      assert.deepStrictEqual(embedded[name], canonical[name])
    }
  })

  for (const compiled of [true, false]) {
    describe(compiled ? 'compiled codecs' : 'interpreted codecs', function () {
      for (const [type, data, hex] of newComponents) {
        it(`26.3 ${type} ${hex}`, function () {
          expectComponent(codecs('26.3', compiled).proto, type, data, hex)
        })
      }

      for (const [type, data, id, body] of [
        ['damage_type', 300, 8, 'ac02'],
        ['use_remainder', template, 25, rawTemplate],
        ['charged_projectiles', { projectiles: [template] }, 51, `01${rawTemplate}`],
        ['bundle_contents', { contents: [template] }, 52, `01${rawTemplate}`],
        ['container', { contents: [undefined, template] }, 77, `020001${rawTemplate}`],
        ['sulfur_cube_content', { absorbedBlockItemStack: template }, 80, rawTemplate]
      ]) {
        it(`26.3 ${type} preserves registry/template field order`, function () {
          expectComponent(codecs('26.3', compiled).proto, type, data, id.toString(16).padStart(2, '0') + body)
        })
      }

      for (const [type, data, id, body] of [
        ['damage_type', 300, 8, 'ac02'],
        ['use_remainder', template, 25, rawTemplate],
        ['charged_projectiles', { projectiles: [template] }, 49, `01${rawTemplate}`],
        ['bundle_contents', { contents: [template] }, 50, `01${rawTemplate}`],
        ['container', { contents: [undefined, template] }, 75, `020001${rawTemplate}`],
        ['sulfur_cube_content', { absorbedBlockItemStack: template }, 78, rawTemplate]
      ]) {
        it(`26.2 ${type} preserves registry/template field order`, function () {
          expectComponent(codecs('26.2', compiled).proto, type, data, id.toString(16).padStart(2, '0') + body)
        })
      }

      for (const version of ['26.2', '26.3']) {
        for (const filtered of [undefined, text('filtered')]) {
          it(`${version} uses a boolean before optional written-book page NBT`, function () {
            const proto = codecs(version, compiled).proto
            const hex = `080003726177${filtered ? '0108000866696c7465726564' : '00'}`
            const value = { content: text('raw'), filteredContent: filtered }
            assert.deepStrictEqual(proto.createPacketBuffer('ItemWrittenBookPage', value), Buffer.from(hex, 'hex'))
            const parsed = proto.parsePacketBuffer('ItemWrittenBookPage', Buffer.from(hex, 'hex'))
            assert.strictEqual(parsed.metadata.size, hex.length / 2)
            assert.deepStrictEqual(parsed.data, value)
          })
        }
        it(`${version} encodes creative decoded patches as length-prefixed component bodies`, async function () {
          const { Item, writes, set } = creativeFixture(version, compiled)
          const item = new Item(1, 2)
          item.components = [{ type: 'damage', data: 300 }, { type: 'unbreakable', data: undefined }]
          item.removedComponents = [{ type: 'custom_name' }]
          await set(item)
          // packetID 0x38/0x39, slot i16, count, itemId, added/removed counts,
          // damage ID + body byteLength + VarInt; unit ID + empty body; removed ID.
          assert.strictEqual(writes[0].bytes.toString('hex'), `${version === '26.2' ? '38' : '39'}0024020102010302ac02040006`)
          assert.deepStrictEqual(writes[0].params.item.components, [
            { type: 'damage', data: Buffer.from('ac02', 'hex') },
            { type: 'unbreakable', data: Buffer.alloc(0) }
          ])
          assert.deepStrictEqual(writes[0].params.item.removeComponents, item.removedComponents)
          assert.strictEqual(item.components[0].data, 300)
        })
      }

      it('26.3 creative sign text uses the same complete body without the component type', async function () {
        const { Item, writes, set } = creativeFixture('26.3', compiled)
        const item = new Item(1, 1)
        const [, data, hex] = newComponents.find(([type]) => type === 'sign_text_back')
        item.components = [{ type: 'sign_text_back', data }]
        await set(item)
        assert.strictEqual(writes[0].params.item.components[0].data.toString('hex'), hex.slice(2))
        const body = hex.slice(2)
        assert.strictEqual(writes[0].bytes.toString('hex'), `3900240101010077${(body.length / 2).toString(16)}${body}`)
      })
    })
  }

  it('uses the public serializer factory when no live serializer is exposed', async function () {
    const { Item, writes, set } = creativeFixture('26.2', true, false)
    const item = new Item(1, 1)
    item.components = [{ type: 'damage', data: 12 }]
    await set(item)
    assert.strictEqual(writes[0].params.item.components[0].data.toString('hex'), '0c')
  })

  it('does not suppress a component-only or removal-only creative update', async function () {
    const { bot, Item, writes, set } = creativeFixture('26.3')
    const item = new Item(1, 1)
    bot.inventory.slots[36] = new Item(1, 1)
    item.components = [{ type: 'damage', data: 12 }]
    await set(item)
    item.components = []
    item.removedComponents = [{ type: 'damage' }]
    await set(item)
    assert.strictEqual(writes.length, 2)
    assert.deepStrictEqual(writes[1].params.item.removeComponents, [{ type: 'damage' }])
  })

  it('preserves the empty-stack creative sentinel', async function () {
    const { bot, Item, writes, set } = creativeFixture('26.3')
    bot.inventory.slots[36] = new Item(1, 1)
    await set(null)
    assert.strictEqual(writes[0].bytes.toString('hex'), '39002400')
  })

  it('keeps legacy1.20.4 creative item serialization', async function () {
    const { Item, writes, set } = creativeFixture('1.20.4')
    await set(new Item(1, 1))
    assert.strictEqual(writes.length, 1)
    assert.strictEqual(writes[0].params.item.itemId, 1)
  })

  it('uses the live serializer context for nested component bodies', async function () {
    const { bot, Item, writes, set } = creativeFixture('26.3')
    const proto = bot._client.serializer.proto
    const encode = proto.createPacketBuffer.bind(proto)
    const calls = []
    proto.createPacketBuffer = (type, value) => {
      calls.push(type)
      return encode(type, value)
    }
    try {
      const item = new Item(1, 1)
      item.components = [{ type: 'container', data: { contents: [undefined, template] } }]
      await set(item)
      assert.ok(calls.includes('SlotComponent'))
      assert.ok(calls.includes('SlotComponentType'))
      assert.strictEqual(writes[0].params.item.components[0].data.toString('hex'), `020001${rawTemplate}`)
    } finally {
      proto.createPacketBuffer = encode
    }
  })
})
