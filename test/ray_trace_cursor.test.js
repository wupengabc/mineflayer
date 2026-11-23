'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const injectRayTrace = require('../lib/plugins/ray_trace')

describe('cursor ray trace', function () {
  it('accepts zero yaw and pitch and starts at eye height', function () {
    const bot = new EventEmitter()
    bot.entity = {
      position: new Vec3(0, 0, 0),
      height: 1.8,
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0
    }
    bot.world = {
      raycast (from, direction, distance) {
        assert.deepStrictEqual(from, new Vec3(0, 1.62, 0))
        assert.ok(Math.abs(direction.x) === 0)
        assert.strictEqual(direction.y, 0)
        assert.strictEqual(direction.z, -1)
        assert.strictEqual(distance, 4.5)
        return { face: 2, intersect: new Vec3(0.5, 1.62, -1) }
      }
    }
    bot.entities = {}
    bot.username = 'bot'

    injectRayTrace(bot)

    const block = bot.blockAtEntityCursor(bot.entity, 4.5)
    assert.strictEqual(block.face, 2)
    assert.deepStrictEqual(block.intersect, new Vec3(0.5, 1.62, -1))
  })

  it('selects an entity when the ray starts inside its hitbox', function () {
    const bot = new EventEmitter()
    const target = {
      type: 'mob',
      username: 'target',
      position: new Vec3(0, 0, -0.2),
      width: 0.6,
      height: 1.8
    }
    bot.entity = {
      position: new Vec3(0, 0, 0),
      height: 1.8,
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0
    }
    bot.world = { raycast: () => null }
    bot.entities = { target }
    bot.username = 'bot'

    injectRayTrace(bot)

    assert.strictEqual(bot.entityAtCursor(3), target)
  })

  it('can include attackable object entities for mouse attacks', function () {
    const bot = new EventEmitter()
    const target = {
      type: 'object',
      name: 'armor_stand',
      username: 'armor_stand',
      position: new Vec3(0, 0, -2),
      width: 0.5,
      height: 1.975
    }
    bot.entity = {
      position: new Vec3(0, 0, 0),
      height: 1.8,
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0
    }
    bot.world = { raycast: () => null }
    bot.entities = { target }
    bot.username = 'bot'

    injectRayTrace(bot)

    assert.strictEqual(bot.entityAtCursor(3), null)
    assert.strictEqual(bot.entityAtCursor(3, true), target)
  })

  it('does not select non-attackable object entities', function () {
    const bot = new EventEmitter()
    bot.entity = {
      position: new Vec3(0, 0, 0),
      height: 1.8,
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0
    }
    bot.world = { raycast: () => null }
    bot.entities = {
      item: {
        type: 'object',
        name: 'item',
        position: new Vec3(0, 1.5, -1),
        width: 0.25,
        height: 0.25
      }
    }
    bot.username = 'bot'

    injectRayTrace(bot)

    assert.strictEqual(bot.entityAtCursor(3, true), null)
  })

  it('uses interaction entity dimensions from metadata', function () {
    const bot = new EventEmitter()
    const target = {
      type: 'other',
      name: 'interaction',
      position: new Vec3(0, 0, -2),
      width: 0,
      height: 0,
      metadata: { 8: 0.5, 9: 1.8 }
    }
    bot.entity = {
      position: new Vec3(0, 0, 0),
      height: 1.8,
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0
    }
    bot.world = { raycast: () => null }
    bot.entities = { target }
    bot.username = 'bot'

    injectRayTrace(bot)

    assert.strictEqual(bot.entityAtCursor(3), target)
  })

  it('can ignore blocks when selecting an entity', function () {
    const bot = new EventEmitter()
    const target = {
      type: 'mob',
      name: 'zombie',
      position: new Vec3(0, 0, -2),
      width: 0.6,
      height: 1.95
    }
    bot.entity = {
      position: new Vec3(0, 0, 0),
      height: 1.8,
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0
    }
    let raycastCalls = 0
    bot.world = {
      raycast: () => {
        raycastCalls++
        return { intersect: new Vec3(0, 1.62, -1) }
      }
    }
    bot.entities = { target }
    bot.username = 'bot'

    injectRayTrace(bot)

    assert.strictEqual(bot.entityAtCursor(3, false, false), null)
    assert.strictEqual(raycastCalls, 1)
    assert.strictEqual(bot.entityAtCursor(3, false, true), target)
    assert.strictEqual(raycastCalls, 1)
  })
})

describe('attack cursor ray trace (Java 26.3)', function () {
  let bot
  let block

  beforeEach(function () {
    bot = {
      entity: { position: new Vec3(0.5, 0, 0), eyeHeight: 1.62, yaw: 0, pitch: 0 },
      registry: require('prismarine-registry')('26.3'),
      entities: {}
    }
    block = null
    bot.world = new (require('prismarine-world')(bot.registry))().sync
    bot.world.getBlock = position => block?.position.equals(position.floored()) ? block : null
    injectRayTrace(bot)
  })

  function add (name, z, x = 0.5, y = 0) {
    const id = Object.keys(bot.entities).length + 1
    return (bot.entities[id] = { ...bot.registry.entitiesByName[name], id, position: new Vec3(x, y, z) })
  }

  it('passes through items, XP and arrows but picks redirectable and shulker projectiles', function () {
    for (const name of ['item', 'experience_orb', 'arrow', 'spectral_arrow', 'trident']) add(name, -1, 0.5, 1.5)
    const zombie = add('zombie', -2)
    assert.strictEqual(bot.attackEntityAtCursor(), zombie)
    const fireball = add('fireball', -2, 1.5, 1.5)
    assert.strictEqual(bot.attackEntityAtCursor(), fireball)
    fireball.isValid = false
    const bullet = add('shulker_bullet', -2, 1.5, 1.5)
    assert.strictEqual(bot.attackEntityAtCursor(), bullet)
  })

  it('uses nearest entry, uninflated living hitboxes and strict entity reach', function () {
    add('zombie', -1, 0.83)
    add('armor_stand', -0.5).metadata = { 15: 1 }
    const stand = add('armor_stand', -3.25)
    assert.strictEqual(bot.attackEntityAtCursor(), null)
    const farther = add('zombie', -4)
    assert.strictEqual(bot.attackEntityAtCursor(5), stand)
    assert.notStrictEqual(bot.attackEntityAtCursor(5), farther)
    bot.entity.attributes = { 'player.entity_interaction_range': { value: 3, modifiers: [{ operation: 0, amount: 1 }] } }
    assert.strictEqual(bot.attackEntityAtCursor(), stand)
  })

  it('picks a falling block even though vanilla damage logic treats it as non-attackable', function () {
    const fallingBlock = add('falling_block', -1, 0.5, 1.5)
    add('zombie', -2)
    assert.strictEqual(bot.attackEntityAtCursor(), fallingBlock)
  })

  it('uses block outlines instead of collision shapes, with block priority on ties', function () {
    const stand = add('armor_stand', -2.25)
    block = { position: new Vec3(0, 1, -3), shapes: [], interactionShapes: [[0, 0, 0, 1, 1, 1]] }
    assert.strictEqual(bot.attackEntityAtCursor(), null)
    assert.strictEqual(bot.attackEntityAtCursor(3, true), stand)
    assert.strictEqual(bot.entityAtCursor(), stand)
    stand.position.z += 0.01
    assert.strictEqual(bot.attackEntityAtCursor(), stand)
  })
})
