'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const packets261 = require('../lib/plugins/packets26_1')

describe('protocol 26.2 packet bridge', function () {
  it('forwards 776 raw packets and preserves their protocol version', function () {
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    bot.protocolVersion = 776
    bot.entity = null
    bot.supportFeature = () => false
    bot._warn = () => {}
    packets261(bot)

    const received = new Promise((resolve) => bot.once('packetUnimplemented', resolve))
    bot._client.emit('rawPacket', {
      packetId: 0x7f,
      state: 'play',
      protocolVersion: 776
    })

    return received.then((packet) => {
      assert.deepStrictEqual(packet, {
        packetId: 0x7f,
        state: 'play',
        protocolVersion: 776,
        name: 'unimplemented_play_0x7f'
      })
      assert.strictEqual(packets261.tagWith261(new Error('test'), 776).protocolVersion, 776)
    })
  })
})
