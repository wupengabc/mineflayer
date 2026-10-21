/* eslint-env mocha */
const assert = require('assert')
const { EventEmitter } = require('events')
const protocol = require('minecraft-protocol')
const createHasher = require('../lib/item_hash')
const injectInventory = require('../lib/plugins/inventory')

// Independent vectors generated with vanilla net.minecraft.util.HashOps.java
// (identical in 26.2/26.3), Guava CRC32C and DFU persistent Codecs in Java.
// HashOps.java:102-185 defines the primitive/map/list payloads. Source files:
// ~/.config/minecraft-dev-mcp/decompiled/{26.2,26.3}/mojmap/net/minecraft/.
// The oracle used DFU RecordCodecBuilder defaults, not network bytes or JSON.
const literal = value => ({ type: 'string', value })
const compound = value => ({ type: 'compound', value })
const componentList = value => ({ type: 'list', value: { type: 'compound', value: value.map(tag => tag.value) } })
const styledText = compound({ text: literal('hello'), bold: { type: 'byte', value: 0 }, color: literal('#00abcd'), font: literal('uniform') })
const explosionDefault = { shape: 'small_ball', colors: [], fadeColors: [], hasTrail: false, hasTwinkle: false }
const explosionCustom = { shape: 'star', colors: [0xabcdef, -1], fadeColors: [0x123456], hasTrail: true, hasTwinkle: true }
const allNbt = {
  type: 'compound',
  value: {
    b: { type: 'byte', value: -4 },
    s: { type: 'short', value: -300 },
    i: { type: 'int', value: 1234567 },
    l: { type: 'long', value: -9007199254740993n },
    f: { type: 'float', value: 0.6 },
    d: { type: 'double', value: -0 },
    text: literal('Hi \uD83D\uDE00'),
    bytes: { type: 'byteArray', value: [-1, 0, 127] },
    ints: { type: 'intArray', value: [-1, 0, 2147483647] },
    longs: { type: 'longArray', value: [-9223372036854775808n, 9007199254740993n] },
    list: { type: 'list', value: { type: 'int', value: [1, 2] } },
    nested: { type: 'compound', value: { x: literal('y') } }
  }
}

for (const version of ['26.2', '26.3']) {
  describe(`${version} hashed inventory slots`, function () {
    let registry, Item, hash
    before(function () {
      registry = require('prismarine-registry')(version)
      Item = require('prismarine-item')(registry)
      hash = createHasher(registry)
    })

    function item (components = [], removedComponents = [], count = 5) {
      const value = Item.fromNotch({ itemId: registry.itemsByName.stone.id, itemCount: count, components, removeComponents: removedComponents })
      return value
    }

    function template (patched = false) {
      return {
        itemId: registry.itemsByName.stone.id,
        itemCount: patched ? 2 : 1,
        components: patched ? [{ type: 'damage', data: 37 }] : [],
        removeComponents: patched ? [{ type: 'unbreakable' }] : []
      }
    }

    const vectors = [
      ['damage', 37, -245894556],
      ['repair_cost', 0, -2146075228],
      ['minimum_attack_charge', 0.5, -1631070359],
      ['enchantment_glint_override', true, -1019818302],
      ['enchantment_glint_override', false, 828198337],
      ['custom_name', literal('Hi \uD83D\uDE00'), 204634964],
      ['custom_name', compound({ text: literal('Hi \uD83D\uDE00') }), 204634964],
      ['custom_name', styledText, -918358185],
      ['item_name', compound({ text: literal('root'), extra: componentList([compound({ text: literal('child') }), styledText]) }), -1646740238],
      ['custom_name', componentList([compound({ text: literal('root') }), compound({ text: literal('child') }), styledText]), -1646740238],
      ['custom_name', compound({ type: literal('text'), text: literal('hello'), italic: { type: 'byte', value: 0 } }), 438916888],
      ['item_name', compound({ translate: literal('custom.message'), fallback: literal('fallback'), with: { type: 'list', value: { type: 'int', value: [7, 2] } } }), 717842830],
      ['item_name', compound({ keybind: literal('key.jump'), italic: { type: 'byte', value: 1 } }), -1798756888],
      ['item_model', 'item/diamond', -755241962],
      ['rarity', 'epic', -292715907],
      ['unbreakable', undefined, -982207288],
      ['lore', [literal('Hi \uD83D\uDE00'), literal('second')], -1420871952],
      ['lore', [literal('hello'), styledText], -1914608183],
      ['enchantable', 15, -199463215],
      ['use_effects', { can_sprint: false, interact_vibrations: true, speed_multiplier: 0.2 }, -982207288],
      ['use_effects', { can_sprint: true, interact_vibrations: false, speed_multiplier: 0.5 }, 1668803792],
      ['food', { nutrition: 4, saturationModifier: 0.6, canAlwaysEat: false }, -99035332],
      ['food', { nutrition: 4, saturationModifier: 0.6, canAlwaysEat: true }, 1330553833],
      ['weapon', { itemDamagePerAttack: 2, disableBlockingForSeconds: 5 }, -760804091],
      ['weapon', { itemDamagePerAttack: 1, disableBlockingForSeconds: 0 }, -982207288],
      ['weapon', { itemDamagePerAttack: 1, disableBlockingForSeconds: -0 }, -1886078495],
      ['custom_model_data', { floats: [], flags: [], strings: [], colors: [] }, -982207288],
      ['custom_model_data', { floats: [0.5, -0], flags: [false, true], strings: ['custom', 'Hi'], colors: [0xabcdef] }, 2041137435],
      ['attack_range', { minRange: 0, maxRange: 3, minCreativeRange: 0, maxCreativeRange: 5, hitboxMargin: 0.3, mobFactor: 1 }, -982207288],
      ['attack_range', { minRange: -0, maxRange: 4, minCreativeRange: 1, maxCreativeRange: 6, hitboxMargin: 0.5, mobFactor: 1.5 }, 1228947416],
      ['writable_book_content', { pages: [] }, -982207288],
      ['writable_book_content', { pages: [{ content: 'hello' }, { content: 'raw', filteredContent: '' }] }, 1436823649],
      ['written_book_content', { rawTitle: 'Title', author: 'Author', generation: 2, resolved: true, pages: [{ content: styledText, filteredContent: literal('filtered') }] }, -1578436805],
      ['written_book_content', { rawTitle: 'Title', author: 'Author', generation: 0, resolved: false, pages: [] }, -2074705234],
      ['written_book_content', { rawTitle: 'Title', filteredTitle: '', author: 'Author', generation: 0, resolved: false, pages: [] }, 1956700996],
      ['firework_explosion', explosionDefault, 1619490100],
      ['firework_explosion', explosionCustom, -1880963778],
      ['fireworks', { flightDuration: 0, explosions: [] }, -982207288],
      ['fireworks', { flightDuration: 1, explosions: [] }, -1231709430],
      ['fireworks', { flightDuration: 255, explosions: [] }, -400630225],
      ['fireworks', { flightDuration: 255, explosions: [explosionDefault, explosionCustom] }, 453507814],
      ['tooltip_display', { hideTooltip: false, hiddenComponents: [] }, -982207288],
      ['tooltip_display', { hideTooltip: true, hiddenComponents: [3, 4] }, -1352061097],
      ['use_cooldown', { seconds: 1.5, cooldownGroup: 'pearl' }, 2005716124],
      ['block_state', { properties: [{ name: 'axis', value: 'x' }, { name: 'waterlogged', value: 'false' }] }, -1367489956],
      ['custom_data', allNbt, -2056666564]
    ]
    for (const [type, data, expected] of vectors) {
      it(`matches independent vanilla ${type} hash ${expected}`, function () {
        assert.strictEqual(hash(item([{ type, data }])).components[0].hash, expected)
      })
    }

    if (version === '26.3') {
      for (const [type, data, expected] of [
        ['compostable', { layers: { isConstant: true, value: 300 } }, 2101416133],
        ['compostable', { layers: { isConstant: false, value: 'minecraft:x' } }, -1684453734],
        ['cooking_fuel', { burnTime: { isConstant: true, value: 1600 }, speedMultiplier: { isConstant: true, value: 1.5 } }, 117333691],
        ['cooking_fuel', { burnTime: { isConstant: false, value: 'minecraft:x' }, speedMultiplier: { isConstant: false, value: 'minecraft:y' } }, 528241218],
        ['brewing_fuel', { uses: { isConstant: true, value: 20 }, speedMultiplier: { isConstant: true, value: 0.5 } }, -1284252337],
        ['brewing_fuel', { uses: { isConstant: false, value: 'minecraft:x' }, speedMultiplier: { isConstant: false, value: 'minecraft:y' } }, 717377169]
      ]) {
        it(`matches independent vanilla ${type} hash ${expected}`, function () {
          assert.strictEqual(hash(item([{ type, data }])).components[0].hash, expected)
          for (const compiled of [true, false]) {
            const proto = protocol.createSerializer({ version, state: 'play', compiled }).proto
            const bytes = proto.createPacketBuffer('SlotComponent', { type, data })
            const parsed = proto.parsePacketBuffer('SlotComponent', bytes)
            assert.strictEqual(parsed.metadata.size, bytes.length)
            assert.strictEqual(hash(item([parsed.data])).components[0].hash, expected)
          }
        })
      }

      it('hashes pottery patterns by received key across ID reorderings and rejects missing entries atomically', async function () {
        const previous = registry.registries
        try {
          const entries = [{ key: 'custom:pattern' }, { key: 'minecraft:flow' }]
          registry.registries = { 'minecraft:decorated_pot_pattern': { entries } }
          assert.strictEqual(hash(item([{ type: 'provides_pottery_pattern', data: 1 }])).components[0].hash, 936670907)
          entries.reverse()
          const bot = botWithCodec()
          bot.inventory.updateSlot(9, item([{ type: 'provides_pottery_pattern', data: 0 }]))
          await bot.clickWindow(9, 0, 0)
          assert.deepStrictEqual(bot.writes[0].params.cursorItem.components, [{ type: 'provides_pottery_pattern', hash: 936670907 }])
          delete registry.registries['minecraft:decorated_pot_pattern']
          const value = bot.inventory.selectedItem
          await assert.rejects(bot.clickWindow(10, 0, 0), /Missing received decorated pot pattern registry entry/)
          assert.strictEqual(bot.writes.length, 1)
          assert.strictEqual(bot.inventory.selectedItem, value)
          assert.strictEqual(bot.inventory.slots[10], null)
          registry.registries['minecraft:decorated_pot_pattern'] = { entries }
          for (const id of [-1, 2, 0.5]) {
            assert.throws(() => hash(item([{ type: 'provides_pottery_pattern', data: id }])), /Missing received decorated pot pattern registry entry/)
          }
        } finally {
          registry.registries = previous
        }
      })

      it('rejects ambiguous resolvable numeric representations before predicting clicks', async function () {
        for (const layers of [1, 'minecraft:x', {}, { isConstant: true, value: 0.5 }, { isConstant: false, value: 'INVALID' }]) {
          const bot = botWithCodec()
          const value = item([{ type: 'compostable', data: { layers } }])
          bot.inventory.updateSlot(9, value)
          await assert.rejects(bot.clickWindow(9, 0, 0), /Cannot hash item component compostable/)
          assert.strictEqual(bot.writes.length, 0)
          assert.strictEqual(bot.inventory.slots[9], value)
          assert.strictEqual(bot.inventory.selectedItem, null)
        }
      })
    }

    for (const compiled of [true, false]) {
      it(`preserves rich text hashes after incoming component decoding (compiled=${compiled})`, function () {
        const proto = protocol.createSerializer({ version, state: 'play', compiled }).proto
        for (const [type, data, expected] of vectors.filter(([type]) => ['custom_name', 'item_name', 'lore', 'written_book_content', 'fireworks', 'firework_explosion'].includes(type))) {
          const buffer = proto.createPacketBuffer('SlotComponent', { type, data })
          const parsed = proto.parsePacketBuffer('SlotComponent', buffer)
          assert.strictEqual(parsed.metadata.size, buffer.length)
          assert.strictEqual(hash(item([parsed.data])).components[0].hash, expected)
        }
      })
    }

    it('appends component list entries after the first component existing siblings', function () {
      const first = compound({ text: literal('root'), extra: componentList([compound({ text: literal('child') })]) })
      assert.strictEqual(hash(item([{ type: 'custom_name', data: componentList([first, styledText]) }])).components[0].hash, -1646740238)
    })

    it('hashes enchantment holders from the received registry, including custom IDs and reorderings', function () {
      const previous = registry.registries
      try {
        registry.registries = { 'minecraft:enchantment': { entries: [{ key: 'custom:blessing' }, { key: 'minecraft:sharpness' }] } }
        const data = { enchantments: [{ id: 1, level: 5 }, { id: 0, level: 2 }] }
        assert.strictEqual(hash(item([{ type: 'enchantments', data }])).components[0].hash, 1261831871)
        assert.strictEqual(hash(item([{ type: 'stored_enchantments', data }])).components[0].hash, 1261831871)
        registry.registries['minecraft:enchantment'].entries.reverse()
        data.enchantments.forEach(entry => { entry.id = 1 - entry.id })
        assert.strictEqual(hash(item([{ type: 'enchantments', data }])).components[0].hash, 1261831871)
        delete registry.registries['minecraft:enchantment']
        assert.throws(() => hash(item([{ type: 'enchantments', data }])), /Missing received enchantment registry/)
        assert.strictEqual(hash(item([{ type: 'enchantments', data: { enchantments: [] } }])).components[0].hash, -982207288)
      } finally {
        registry.registries = previous
      }
    })

    for (const [type, data, expected] of [
      ['dyed_color', 0xabcdef, 591767866],
      ['dye', 11, 199633461],
      ['base_color', 11, 199633461],
      ['wolf/collar', 11, 199633461],
      ['cat/collar', 11, 199633461],
      ['sheep/color', 11, 199633461],
      ['shulker/color', 11, 199633461],
      ['tropical_fish/base_color', 11, 199633461],
      ['tropical_fish/pattern_color', 11, 199633461],
      ...(version === '26.2'
        ? [
            ['map_color', 0xabcdef, 591767866],
            ['swing_animation', { type: 'whack', duration: 6 }, -982207288],
            ['swing_animation', { type: 'stab', duration: 8 }, 1844981812]
          ]
        : [
            ['cushion/color', 'blue', 199633461],
            ['attack_animation', { type: 'whack', duration: 6 }, -982207288],
            ['interact_animation', { type: 'stab', duration: 8 }, 1844981812],
            ['villager_food', { nutrition: 8 }, -1597876080]
          ])
    ]) {
      it(`matches independent vanilla ${type} hash ${expected}`, function () {
        assert.strictEqual(hash(item([{ type, data }])).components[0].hash, expected)
      })
    }

    it('preserves typed NBT long pairs and ignores compound insertion order', function () {
      const tag = structuredClone(allNbt)
      tag.value = Object.fromEntries(Object.entries(tag.value).reverse())
      tag.value.l.value = [-2097153, -1]
      tag.value.longs.value = [[-2147483648, 0], [2097152, 1]]
      assert.strictEqual(hash(item([{ type: 'custom_data', data: tag }])).components[0].hash, -2056666564)
    })

    it('matches vanilla nested template and sparse container hashes', function () {
      for (const [type, data, expected] of [
        ['use_remainder', template(), 725422587],
        ['use_remainder', template(true), 57061604],
        ['sulfur_cube_content', { absorbedBlockItemStack: template(true) }, 57061604],
        ['charged_projectiles', { projectiles: [template(), template(true)] }, -1888893412],
        ['bundle_contents', { contents: [template(), template(true)] }, -1888893412],
        ['container', { contents: [undefined, template(true), undefined, template(), undefined] }, -539132489],
        ['container', { contents: [undefined, undefined] }, -1978007022]
      ]) assert.strictEqual(hash(item([{ type, data }])).components[0].hash, expected, type)
    })

    it('omits transient components inside persistent templates without omitting the nonempty patch field', function () {
      const nested = template()
      nested.components = [{ type: 'creative_slot_lock' }, { type: 'additional_trade_cost', data: 4 }]
      nested.removeComponents = [{ type: 'map_post_processing' }]
      assert.strictEqual(hash(item([{ type: 'use_remainder', data: nested }])).components[0].hash, 1407893780)
    })

    it('rejects invalid nested counts, oversized containers and unsupported nested codecs', function () {
      for (const count of [0, 100]) {
        const nested = { ...template(), itemCount: count }
        assert.throws(() => hash(item([{ type: 'use_remainder', data: nested }])), /Invalid template item count/)
      }
      assert.throws(() => hash(item([{ type: 'container', data: { contents: Array(257).fill(undefined) } }])), /256 slots/)
      assert.throws(() => hash(item([{ type: 'charged_projectiles', data: { projectiles: Array(1025).fill(template()) } }])), /1024 entries/)
      const nested = template()
      nested.components = [{ type: 'consumable', data: {} }]
      assert.throws(() => hash(item([{ type: 'bundle_contents', data: { contents: [nested] } }])), /Codec is not implemented/)
      assert.throws(() => hash(item([{ type: 'writable_book_content', data: { pages: Array(101).fill({ content: '' }) } }])), /100 pages/)
      assert.throws(() => hash(item([{ type: 'writable_book_content', data: { pages: [{ content: 'x'.repeat(1025) }] } }])), /1024 characters/)
      assert.throws(() => hash(item([{ type: 'lore', data: Array(257).fill(literal('line')) }])), /256 lines/)
      assert.throws(() => hash(item([{ type: 'fireworks', data: { flightDuration: 0, explosions: Array(257).fill(explosionDefault) } }])), /256 explosions/)
      for (const flightDuration of [-1, 256, 0.5]) {
        assert.throws(() => hash(item([{ type: 'fireworks', data: { flightDuration, explosions: [] } }])), /Invalid firework flight duration/)
      }
      assert.throws(() => hash(item([{ type: 'firework_explosion', data: { ...explosionDefault, shape: 'unknown' } }])), /Invalid firework shape/)
    })

    it('encodes only the patch, and represents empty stacks as null', function () {
      assert.strictEqual(hash(null), null)
      assert.strictEqual(hash({ type: 0, count: 10 }), null)
      assert.strictEqual(hash({ type: 1, count: 0 }), null)
      assert.deepStrictEqual(hash(item()), { itemId: registry.itemsByName.stone.id, itemCount: 5, components: [], removeComponents: [] })
      const id = Number(Object.entries(registry.protocol.types.SlotComponentType[1].mappings).find(([, name]) => name === 'damage')[0])
      assert.deepStrictEqual(hash(item([], [{ type: id }])).removeComponents, [{ type: 'damage' }])
    })

    it('rejects unsupported persistent Codecs and ambiguous values', function () {
      for (const component of [
        { type: 'custom_name', data: compound({ text: literal('hello'), click_event: compound({ action: literal('run_command'), command: literal('/help') }) }) },
        { type: 'consumable', data: {} },
        { type: 'creative_slot_lock' },
        { type: 'custom_data', data: { type: 'compound', value: { l: { type: 'long', value: 9007199254740992 } } } }
      ]) assert.throws(() => hash(item([component])), /Cannot hash item component/)
      assert.throws(() => hash(item([{ type: 'damage', data: 1 }, { type: 'damage', data: 2 }])), /Duplicate/)
      assert.throws(() => hash(item([{ type: 'damage', data: 1 }], [{ type: 'damage' }])), /both adds and removes/)
    })

    it('rejects unsupported rich text and malformed lists before writing or predicting', async function () {
      for (const text of [
        componentList([]), compound({ text: literal('hello'), extra: componentList([]) }),
        compound({ type: literal('translate'), translate: literal('custom.message') }),
        compound({ selector: literal('@p') }), compound({ text: literal('hello'), color: literal('unknown') }),
        compound({ text: literal('hello'), hover_event: compound({ action: literal('show_entity') }) })
      ]) {
        const bot = botWithCodec()
        const value = item([{ type: 'custom_name', data: text }])
        bot.inventory.updateSlot(9, value)
        await assert.rejects(bot.clickWindow(9, 0, 0), /Cannot hash item component custom_name/)
        assert.strictEqual(bot.writes.length, 0)
        assert.strictEqual(bot.inventory.slots[9], value)
        assert.strictEqual(bot.inventory.selectedItem, null)
      }
    })

    it('rejects invalid signed-book generations and overlong filtered titles', function () {
      const data = { rawTitle: 'Title', author: 'Author', generation: 0, resolved: false, pages: [] }
      for (const generation of [-1, 4, 0.5]) {
        assert.throws(() => hash(item([{ type: 'written_book_content', data: { ...data, generation } }])), /Invalid written book generation/)
      }
      assert.throws(() => hash(item([{ type: 'written_book_content', data: { ...data, filteredTitle: 'x'.repeat(33) } }])), /32 characters/)
    })

    function botWithCodec () {
      const bot = new EventEmitter()
      bot.version = version
      bot.registry = registry
      bot.protocolVersion = registry.version.version
      bot.supportFeature = registry.supportFeature
      bot._client = new EventEmitter()
      bot.writes = []
      const serializer = protocol.createSerializer({ version, state: 'play', isServer: false })
      const parser = protocol.createDeserializer({ version, state: 'play', isServer: true, noErrorLogging: true })
      bot._client.write = (name, params) => {
        const buffer = serializer.createPacketBuffer({ name, params })
        const decoded = parser.parsePacketBuffer(buffer)
        assert.strictEqual(decoded.metadata.size, buffer.length)
        bot.writes.push({ ...decoded.data, buffer })
      }
      injectInventory(bot, { hideErrors: true })
      return bot
    }

    it('uses exact wire bytes for absent cursor and ordinary stack pickup', async function () {
      const bot = botWithCodec()
      await bot.clickWindow(9, 0, 0)
      // Packet id is version dependent. The remainder follows vanilla's codec.
      assert.strictEqual(bot.writes[0].buffer.subarray(1).toString('hex'), '00ffffffff0f000900000000')
      bot.inventory.updateSlot(9, item([{ type: 'damage', data: 37 }], [{ type: 'unbreakable' }]))
      await bot.clickWindow(9, 0, 0)
      const packet = bot.writes[1].params
      assert.deepStrictEqual(packet.changedSlots, [{ location: 9, item: undefined }])
      assert.strictEqual(packet.cursorItem.itemId, registry.itemsByName.stone.id)
      assert.strictEqual(packet.cursorItem.itemCount, 5)
      assert.deepStrictEqual(packet.cursorItem.components, [{ type: 'damage', hash: -245894556 }])
      assert.deepStrictEqual(packet.cursorItem.removeComponents, [{ type: 'unbreakable' }])
      assert.strictEqual(bot.writes[1].buffer.subarray(1).toString('hex'), '00ffffffff0f00090000010009000101050103f157f2640104')
    })

    it('sends the persistent enchantment hash rather than the network IDs on pickup', async function () {
      const previous = registry.registries
      try {
        registry.registries = { 'minecraft:enchantment': { entries: [{ key: 'custom:blessing' }, { key: 'minecraft:sharpness' }] } }
        const bot = botWithCodec()
        bot.inventory.updateSlot(9, item([{ type: 'enchantments', data: { enchantments: [{ id: 1, level: 5 }, { id: 0, level: 2 }] } }]))
        await bot.clickWindow(9, 0, 0)
        assert.deepStrictEqual(bot.writes[0].params.cursorItem.components, [{ type: 'enchantments', hash: 1261831871 }])
        assert.strictEqual(bot.inventory.selectedItem.components[0].data.enchantments[0].id, 1)
      } finally {
        registry.registries = previous
      }
    })

    it('preserves nested container patches when picking up and splitting actual wire stacks', async function () {
      const bot = botWithCodec()
      bot.inventory.updateSlot(9, item([{ type: 'container', data: { contents: [undefined, template(true), undefined, template()] } }]))
      await bot.clickWindow(9, 1, 0)
      assert.strictEqual(bot.writes[0].params.cursorItem.components[0].hash, -539132489)
      assert.strictEqual(bot.writes[0].params.changedSlots[0].item.components[0].hash, -539132489)
      assert.strictEqual(bot.inventory.selectedItem.components[0].data.contents[1].components[0].data, 37)
    })

    it('writes styled signed-book hashes on pickup while preserving decoded page components', async function () {
      const bot = botWithCodec()
      const pages = [{ content: styledText, filteredContent: literal('filtered') }]
      bot.inventory.updateSlot(9, item([{ type: 'written_book_content', data: { rawTitle: 'Title', author: 'Author', generation: 2, resolved: true, pages } }]))
      await bot.clickWindow(9, 0, 0)
      assert.deepStrictEqual(bot.writes[0].params.cursorItem.components, [{ type: 'written_book_content', hash: -1578436805 }])
      assert.deepStrictEqual(bot.inventory.selectedItem.components[0].data.pages, pages)
    })

    it('retains nested firework hashes when splitting and rejects invalid rockets before mutation', async function () {
      const bot = botWithCodec()
      const data = { flightDuration: 255, explosions: [explosionDefault, explosionCustom] }
      bot.inventory.updateSlot(9, item([{ type: 'fireworks', data }]))
      await bot.clickWindow(9, 1, 0)
      assert.strictEqual(bot.writes[0].params.cursorItem.components[0].hash, 453507814)
      assert.strictEqual(bot.writes[0].params.changedSlots[0].item.components[0].hash, 453507814)
      const bad = item([{ type: 'fireworks', data: { ...data, flightDuration: 256 } }])
      bot.inventory.updateSlot(10, bad)
      const cursor = bot.inventory.selectedItem
      await assert.rejects(bot.clickWindow(10, 0, 0), /Invalid firework flight duration/)
      assert.strictEqual(bot.writes.length, 1)
      assert.strictEqual(bot.inventory.selectedItem, cursor)
      assert.strictEqual(bot.inventory.slots[10], bad)
    })

    it('reproduces the normal-slot caller bug independently of decoder errors', function () {
      const serializer = protocol.createSerializer({ version, state: 'play', isServer: false })
      const parser = protocol.createDeserializer({ version, state: 'play', isServer: true, noErrorLogging: true })
      const value = item([{ type: 'damage', data: 37 }])
      const params = { windowId: 0, stateId: 0, slot: 9, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: Item.toNotch(value) }
      const bad = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'window_click', params })).data.params
      assert.strictEqual(bad.cursorItem.components[0].hash, 0)
      assert.notStrictEqual(bad.cursorItem.components[0].hash, -245894556)
      params.cursorItem = hash(value)
      const good = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'window_click', params })).data.params
      assert.strictEqual(good.cursorItem.components[0].hash, -245894556)
      params.cursorItem = Item.toNotch(null)
      const badEmpty = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'window_click', params })).data.params
      assert.strictEqual(badEmpty.cursorItem.itemId, 0)
      assert.strictEqual(badEmpty.cursorItem.itemCount, 0)
      params.cursorItem = hash(null)
      const goodEmpty = parser.parsePacketBuffer(serializer.createPacketBuffer({ name: 'window_click', params })).data.params
      assert.strictEqual(goodEmpty.cursorItem, undefined)
    })

    it('retains component patches on right-click split and single placement', async function () {
      const bot = botWithCodec()
      bot.inventory.updateSlot(9, item([{ type: 'custom_data', data: allNbt }], [{ type: 'unbreakable' }]))
      await bot.clickWindow(9, 1, 0)
      assert.strictEqual(bot.writes[0].params.changedSlots[0].item.itemCount, 2)
      assert.strictEqual(bot.writes[0].params.cursorItem.itemCount, 3)
      assert.strictEqual(bot.writes[0].params.cursorItem.components[0].hash, -2056666564)
      await bot.clickWindow(10, 1, 0)
      assert.strictEqual(bot.writes[1].params.changedSlots[0].item.itemCount, 1)
      assert.strictEqual(bot.writes[1].params.changedSlots[0].item.components[0].hash, -2056666564)
      assert.deepStrictEqual(bot.writes[1].params.changedSlots[0].item.removeComponents, [{ type: 'unbreakable' }])
    })

    it('rejects an unsupported click before write or local prediction', async function () {
      const bot = botWithCodec()
      const value = item([{ type: 'consumable', data: {} }])
      bot.inventory.updateSlot(9, value)
      await assert.rejects(bot.clickWindow(9, 0, 0), /Cannot hash item component consumable/)
      assert.strictEqual(bot.writes.length, 0)
      assert.strictEqual(bot.inventory.slots[9], value)
      assert.strictEqual(bot.inventory.selectedItem, null)
    })

    it('supports number-key swaps with typed long NBT without JSON cloning', async function () {
      const bot = botWithCodec()
      bot.inventory.updateSlot(9, item([{ type: 'custom_data', data: allNbt }]))
      await bot.clickWindow(9, 0, 2)
      assert.deepStrictEqual(bot.writes[0].params.changedSlots.map(slot => slot.location), [9, 36])
      assert.strictEqual(bot.writes[0].params.changedSlots[1].item.components[0].hash, -2056666564)
    })

    it('rejects unsupported swap destinations before prediction events or item mutation', async function () {
      const bot = botWithCodec()
      const source = item([{ type: 'damage', data: 37 }])
      const destination = item([{ type: 'consumable', data: {} }])
      bot.inventory.updateSlot(9, source)
      bot.inventory.updateSlot(36, destination)
      let updates = 0
      bot.inventory.on('updateSlot', () => { updates++ })
      await assert.rejects(bot.clickWindow(9, 0, 2), /Cannot hash item component consumable/)
      assert.strictEqual(bot.writes.length, 0)
      assert.strictEqual(updates, 0)
      assert.strictEqual(bot.inventory.slots[9], source)
      assert.strictEqual(bot.inventory.slots[36], destination)
      assert.strictEqual(source.slot, 9)
      assert.strictEqual(destination.slot, 36)
      assert.strictEqual(bot.inventory.selectedItem, null)
    })

    it('does not hash unrelated unchanged slots during fallback change detection', async function () {
      const bot = botWithCodec()
      bot.inventory.updateSlot(9, item([{ type: 'damage', data: 37 }]))
      bot.inventory.updateSlot(11, item([{ type: 'consumable', data: {} }]))
      await bot.clickWindow(9, 0, 2)
      assert.deepStrictEqual(bot.writes[0].params.changedSlots.map(slot => slot.location), [9, 36])
    })

    it('uses hashed cursor for syncWindow and rejects unsupported sync without sending', async function () {
      const bot = botWithCodec()
      bot.inventory.selectedItem = item([{ type: 'damage', data: 37 }])
      const synced = bot._syncWindow(bot.inventory)
      assert.strictEqual(bot.writes[0].params.cursorItem.components[0].hash, -245894556)
      bot.emit('setWindowItems:0')
      await synced
      bot.inventory.selectedItem = item([{ type: 'consumable', data: {} }])
      await assert.rejects(bot._syncWindow(bot.inventory), /Cannot hash item component consumable/)
      assert.strictEqual(bot.writes.length, 1)
      assert.strictEqual(bot.listenerCount('setWindowItems:0'), 0)
    })
  })
}

describe('legacy window slot compatibility', function () {
  it('keeps ordinary Item.toNotch cursor encoding for 1.21.4', async function () {
    const version = '1.21.4'
    const bot = new EventEmitter()
    bot.version = version
    bot.registry = require('prismarine-registry')(version)
    bot.supportFeature = bot.registry.supportFeature
    bot._client = new EventEmitter()
    const writes = []
    const serializer = protocol.createSerializer({ version, state: 'play', isServer: false })
    const parser = protocol.createDeserializer({ version, state: 'play', isServer: true, noErrorLogging: true })
    bot._client.write = (name, params) => writes.push(parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params)
    injectInventory(bot, { hideErrors: true })
    const Item = require('prismarine-item')(bot.registry)
    bot.inventory.updateSlot(9, Item.fromNotch({ itemId: 1, itemCount: 5, components: [{ type: 'damage', data: 37 }], removeComponents: [] }))
    await bot.clickWindow(9, 0, 0)
    assert.strictEqual(writes[0].cursorItem.itemCount, 5)
    assert.deepStrictEqual(writes[0].cursorItem.components, [{ type: 'damage', data: 37 }])
  })
})
