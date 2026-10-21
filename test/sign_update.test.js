/* eslint-env mocha */
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const injectBlocks = require('../lib/plugins/blocks')
const { createSerializer, createDeserializer } = require('minecraft-protocol')

describe('vanilla sign updates', function () {
  for (const version of ['26.2', '26.3']) {
    for (const back of [false, true]) {
      it(`${version}: writes padded ${back ? 'back' : 'front'} text using the versioned layout`, function () {
        const bot = new EventEmitter()
        bot.version = version
        bot.registry = require('prismarine-registry')(version)
        bot.protocolVersion = bot.registry.version.version
        bot.supportFeature = bot.registry.supportFeature
        bot._client = new EventEmitter()
        const serializer = createSerializer({ version, state: 'play', isServer: false })
        const parser = createDeserializer({ version, state: 'play', isServer: true })
        let packet
        bot._client.write = (name, params) => {
          const bytes = serializer.createPacketBuffer({ name, params })
          const decoded = parser.parsePacketBuffer(bytes)
          assert.strictEqual(decoded.metadata.size, bytes.length)
          packet = decoded.data.params
        }
        injectBlocks(bot, { version })
        bot.updateSign({ position: new Vec3(1, 64, 2) }, 'one\ntwo', back)
        if (version === '26.3') {
          assert.deepStrictEqual(packet.lines, ['one', 'two', '', ''])
          assert.strictEqual(packet.slot, back ? 'back' : 'front')
        } else {
          assert.strictEqual(packet.text1, 'one')
          assert.strictEqual(packet.text4, '')
          assert.strictEqual(packet.isFrontText, !back)
        }
      })
    }
  }
})
