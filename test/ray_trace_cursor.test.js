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
})
