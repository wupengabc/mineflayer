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
