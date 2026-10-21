/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const protocol = require('minecraft-protocol')
const injectEntities = require('../lib/plugins/entities')
const injectInventory = require('../lib/plugins/inventory')
const injectPhysics = require('../lib/plugins/physics')
const injectBridge = require('../lib/plugins/packets26_1')

describe('vanilla packet sending phases with real codecs', function () {
  let now
  let timer
  let bot
  let originalInterval
  let originalClearInterval
  let originalNow

  beforeEach(function () {
    now = 0
    originalInterval = global.setInterval
    originalClearInterval = global.clearInterval
    originalNow = performance.now
    global.setInterval = callback => { timer = callback; return callback }
    global.clearInterval = () => { timer = null }
    performance.now = () => now
  })

  afterEach(function () {
    if (bot) bot.emit('end')
    bot = null
    global.setInterval = originalInterval
    global.clearInterval = originalClearInterval
    performance.now = originalNow
  })

  function createBot (version) {
    bot = new EventEmitter()
    bot.version = version
    bot.registry = require('prismarine-registry')(version)
    bot.protocolVersion = bot.registry.version.version
    bot.supportFeature = bot.registry.supportFeature
    bot._client = new EventEmitter()
    bot._client.state = 'play'
    bot._client.username = 'test'
    const serializer = protocol.createSerializer({ version, state: 'play', isServer: false })
    const parser = protocol.createDeserializer({ version, state: 'play', isServer: true, noErrorLogging: true })
    bot.writes = []
    bot._client.write = bot._client.writePriority = (name, params) => {
      const buffer = serializer.createPacketBuffer({ name, params })
      const decoded = parser.parsePacketBuffer(buffer)
      assert.strictEqual(decoded.metadata.size, buffer.length, `${name} consumes its full wire payload`)
      bot.writes.push(decoded.data)
    }
    bot.world = { getColumnAt: () => ({}) }
    bot.blockAt = () => ({})
    bot.isAlive = true
    injectEntities(bot)
    injectInventory(bot, { hideErrors: true })
    injectPhysics(bot, {})
    injectBridge(bot)
    bot._client.emit('login', { entityId: 1 })
    bot.emit('login')
    bot._client.emit('position', { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1 })
    bot.physics.simulatePlayer = () => ({ apply: () => { bot.entity.position.x += 0.1 } })
    bot.writes.length = 0
    return bot
  }

  function tick () {
    now += 50
    timer()
  }

  for (const version of ['26.2', '26.3']) {
    it(`${version}: emits keybinding actions before input, sprint, movement and tick_end`, function () {
      const bot = createBot(version)
      bot.on('prePhysicsTick', () => {
        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)
        bot.attack({ id: 42 })
      })
      assert.deepStrictEqual(bot.writes, [])
      tick()
      assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
        'attack', version === '26.3' ? 'punch' : 'arm_animation',
        'player_input', 'entity_action', 'position', 'tick_end'
      ])
      assert.strictEqual(bot.writes[0].params.entityId, 42)
      assert.strictEqual(bot.writes[2].params.inputs.forward, true)
    })

    it(`${version}: keeps an awaited turn's attack in the next pre-movement interval`, async function () {
      const bot = createBot(version)
      const attacking = (async () => {
        await bot.look(bot.entity.yaw, 0.1)
        bot.attack({ id: 42 })
      })()
      tick()
      tick()
      await attacking
      const names = bot.writes.map(packet => packet.name)
      assert.deepStrictEqual(names.slice(-3), ['tick_end', 'attack', version === '26.3' ? 'punch' : 'arm_animation'])
      tick()
      assert.deepStrictEqual(bot.writes.slice(-2).map(packet => packet.name), ['position', 'tick_end'])
    })

    it(`${version}: right-click and air use share prediction sequences without an extra 26.3 punch`, async function () {
      const bot = createBot(version)
      bot.lookAt = async () => {}
      bot.activateItem()
      await bot.activateBlock({ position: new Vec3(0, 63, 0) })
      bot.deactivateItem()
      assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
        'use_item', 'block_place', ...(version === '26.3' ? [] : ['arm_animation']), 'block_dig'
      ])
      assert.strictEqual(bot.writes[0].params.sequence, 1)
      assert.strictEqual(bot.writes[1].params.sequence, 2)
      assert.strictEqual(bot.writes.at(-1).params.sequence, 0)
    })

    it(`${version}: sends STAB for vanilla and component-defined piercing weapons`, function () {
      const bot = createBot(version)
      bot.QUICK_BAR_START = 36
      bot.quickBarSlot = 0
      bot.inventory.slots[36] = { name: 'wooden_spear', componentMap: new Map() }
      bot.attack({ id: 42 })
      assert.deepStrictEqual(bot.writes.map(packet => packet.name), [
        'block_dig', ...(version === '26.3' ? [] : ['arm_animation'])
      ])
      assert.strictEqual(bot.writes[0].params.status, version === '26.3' ? 8 : 7)
      assert.strictEqual(bot.writes[0].params.sequence, 0)
      bot.writes.length = 0
      bot.inventory.slots[36] = { name: 'stick', componentMap: new Map([['piercing_weapon', { data: {} }]]) }
      bot.attack({ id: 42 })
      assert.strictEqual(bot.writes[0].params.status, version === '26.3' ? 8 : 7)
      bot.writes.length = 0
      bot.inventory.slots[36] = { name: 'wooden_spear', removedComponents: [{ type: 'piercing_weapon' }] }
      bot.attack({ id: 42 })
      assert.strictEqual(bot.writes[0].name, 'attack')
    })

    it(`${version}: reconciles active-use metadata before exposing entityUpdate`, function () {
      const bot = createBot(version)
      let updates = 0
      bot.on('entityUpdate', entity => {
        if (entity !== bot.entity) return
        updates++
        bot.attack({ id: 42 })
      })
      bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 8, type: 'byte', value: 3 }] })
      assert.strictEqual(bot.entity.activeHand, 'off-hand')
      assert.deepStrictEqual(bot.writes, [])
      bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, type: 'byte', value: 0 }] })
      assert.deepStrictEqual(bot.writes, [], 'omitted active-use field does not clear it')
      bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 8, type: 'byte', value: 0 }] })
      assert.strictEqual(updates, 3)
      assert.strictEqual(bot.writes[0].name, 'attack')
    })

    it(`${version}: vehicle controls use one complete input report before passenger look`, function () {
      const bot = createBot(version)
      bot.vehicle = { id: 5 }
      bot.emit('mount')
      bot.setControlState('jump', true)
      bot.moveVehicle(1, 1)
      bot.dismount()
      assert.deepStrictEqual(bot.writes, [])
      tick()
      assert.deepStrictEqual(bot.writes.map(packet => packet.name), ['player_input', 'look', 'tick_end'])
      const inputs = bot.writes[0].params.inputs
      assert.strictEqual(inputs.forward, true)
      assert.strictEqual(inputs.left, true)
      assert.strictEqual(inputs.jump, true)
      assert.strictEqual(inputs.shift, true)
    })

    it(`${version}: repeated use preserves the active hand while metadata is pending`, function () {
      const bot = createBot(version)
      bot.QUICK_BAR_START = 36
      bot.quickBarSlot = 0
      bot.food = 10
      bot.inventory.slots[36] = { type: 1, name: 'apple' }
      bot.activateItem()
      bot.activateItem(true)
      bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:apple', cooldownTicks: 10 })
      bot.activateItem()
      bot.attack({ id: 42 })
      assert.strictEqual(bot.usingHeldItem, true)
      assert.deepStrictEqual(bot.writes.map(packet => packet.name), ['use_item', 'use_item', 'use_item'])
      bot.emit('heldItemChanged', { type: 2, name: 'stick' })
      assert.strictEqual(bot.usingHeldItem, false)
    })

    it(`${version}: requested hands and unrelated metadata cannot replace the active hand`, function () {
      const bot = createBot(version)
      bot.QUICK_BAR_START = 36
      bot.quickBarSlot = 0
      bot.food = 10
      bot.inventory.slots[36] = { type: 1, name: 'apple' }
      bot.inventory.slots[45] = { type: 9, name: 'apple' }
      const flags = value => bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 8, type: 'byte', value }] })
      flags(3)
      bot.activateItem()
      bot.emit('heldItemChanged', { type: 2, name: 'stick' })
      assert.strictEqual(bot.usingHeldItem, true)
      bot.inventory.updateSlot(45, { type: 10, name: 'stick' })
      assert.strictEqual(bot.usingHeldItem, false)
      flags(2)
      bot.activateItem()
      bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 0, type: 'byte', value: 0 }] })
      bot.emit('heldItemChanged', { type: 2, name: 'stick' })
      assert.strictEqual(bot.usingHeldItem, false)
    })

    it(`${version}: an old consume timeout cannot release a use started after metadata ends it`, async function () {
      const bot = createBot(version)
      bot.QUICK_BAR_START = 36
      bot.quickBarSlot = 0
      bot.food = 10
      bot.game = { gameMode: 'survival' }
      bot.inventory.slots[36] = { type: 1, name: 'apple' }
      bot.inventory.slots[45] = { type: 9, name: 'apple' }
      const originalTimeout = global.setTimeout
      let expire
      global.setTimeout = callback => { expire = callback }
      try {
        const consuming = assert.rejects(bot.consume(), /timed out/)
        bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 8, type: 'byte', value: 1 }] })
        bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 8, type: 'byte', value: 0 }] })
        bot.activateItem(true)
        expire()
        await consuming
        assert.deepStrictEqual(bot.writes.map(packet => packet.name), ['use_item', 'use_item'])
        assert.strictEqual(bot.usingHeldItem, true)
      } finally {
        global.setTimeout = originalTimeout
      }
    })
  }
})
