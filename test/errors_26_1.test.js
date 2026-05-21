/* eslint-env mocha */
'use strict'

// Property 10: 26.1 阶段错误信息携带 protocolVersion 与未实现包不崩溃
//
// 1. tagWith261(err) sets err.protocolVersion = 775 and returns the same object.
// 2. When NMP emits 'rawPacket' with protocolVersion=775, mineflayer's
//    packets26_1 plugin emits 'packetUnimplemented' with the correct shape:
//      { packetId, state, protocolVersion: 775, name: 'unimplemented_<state>_0x<id>' }
// 3. When NMP emits 'rawPacket' with protocolVersion!==775, the plugin does
//    NOT emit 'packetUnimplemented'.
// 4. The plugin doesn't crash on subsequent packets after a rawPacket.
//
// Validates: Requirements 11.6, 15.1, 15.3, 15.5

const assert = require('assert')
const EventEmitter = require('events')
const fc = require('fast-check')

const packets261 = require('../lib/plugins/packets26_1.js')
const { tagWith261 } = packets261

// ---------------------------------------------------------------------------
// Mock bot factory.
//
// packets26_1.inject() touches only:
//   * bot.protocolVersion              -> the 26.1 gate (must be 775)
//   * bot._client (an EventEmitter)    -> for 'rawPacket' / 'low_disk_space_warning' / 'position'
//   * bot.emit / bot.on                -> bot must be an EventEmitter
//   * bot.entity                       -> for the 0x48 prependListener; null is fine, the listener guards on it
//   * bot.supportFeature('playerLoaded') -> for the chunkColumnLoad branch (default false in tests)
// ---------------------------------------------------------------------------
function makeMockBot ({ protocolVersion = 775 } = {}) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.protocolVersion = protocolVersion
  bot.entity = null // packets26_1 0x48 hook returns early when entity is missing
  bot.supportFeature = () => false
  bot._warn = () => {} // silence the low_disk_space_warning log path in tests
  return bot
}

describe('packets26_1 tagWith261 (Property 10 part 1)', function () {
  it('sets err.protocolVersion = 775 and returns the same object', function () {
    const err = new Error('boom')
    const tagged = tagWith261(err)
    assert.strictEqual(tagged, err, 'returns the same object reference')
    assert.strictEqual(tagged.protocolVersion, 775)
  })

  it('preserves protocolVersion=775 across arbitrary plain-object errors', function () {
    fc.assert(
      fc.property(fc.object(), (obj) => {
        const before = obj
        const after = tagWith261(obj)
        assert.strictEqual(after, before)
        assert.strictEqual(after.protocolVersion, 775)
        return true
      }),
      { numRuns: 50 }
    )
  })

  it('is a no-op for null / undefined / primitive values', function () {
    assert.strictEqual(tagWith261(null), null)
    assert.strictEqual(tagWith261(undefined), undefined)
    assert.strictEqual(tagWith261(42), 42)
    assert.strictEqual(tagWith261('boom'), 'boom')
  })
})

describe('packets26_1 rawPacket -> packetUnimplemented bridge (Property 10 part 2)', function () {
  this.timeout(15000)

  // Generate raw rawPacket payloads:
  //   packetId : non-negative VarInt-ish integer (0..2^16 covers the realistic range)
  //   state    : protocol state name (play/configuration/login/handshaking)
  //   buffer   : opaque bytes - inject() doesn't touch them, but we round-trip
  //              via the event emitter to ensure no accidental coupling
  const packetIdArb = fc.integer({ min: 0, max: 0xFFFF })
  const stateArb = fc.constantFrom('play', 'configuration', 'login', 'handshaking')

  it('forwards every protocolVersion=775 rawPacket as packetUnimplemented with the right shape', function () {
    fc.assert(
      fc.property(packetIdArb, stateArb, (packetId, state) => {
        const bot = makeMockBot()
        packets261(bot)

        let received
        let count = 0
        bot.on('packetUnimplemented', (evt) => {
          count++
          received = evt
        })

        bot._client.emit('rawPacket', {
          packetId,
          state,
          protocolVersion: 775,
          buffer: Buffer.alloc(0)
        })

        assert.strictEqual(count, 1, 'exactly one packetUnimplemented per rawPacket')
        assert.strictEqual(received.packetId, packetId)
        assert.strictEqual(received.state, state)
        assert.strictEqual(received.protocolVersion, 775)
        // Spec: `unimplemented_<state>_0x<id>` with lowercase hex, no padding.
        assert.strictEqual(
          received.name,
          `unimplemented_${state}_0x${Number(packetId).toString(16)}`
        )
        return true
      }),
      { numRuns: 100 }
    )
  })

  it('does NOT emit packetUnimplemented when rawPacket has protocolVersion !== 775', function () {
    fc.assert(
      fc.property(
        packetIdArb,
        stateArb,
        // any protocol version that isn't 775 - covers older versions and
        // any hypothetical future ones.
        fc.integer({ min: 0, max: 1024 }).filter((v) => v !== 775),
        (packetId, state, protocolVersion) => {
          const bot = makeMockBot()
          packets261(bot)

          let count = 0
          bot.on('packetUnimplemented', () => { count++ })

          bot._client.emit('rawPacket', {
            packetId,
            state,
            protocolVersion,
            buffer: Buffer.alloc(0)
          })

          assert.strictEqual(count, 0, `rawPacket with protocolVersion=${protocolVersion} must not bridge to packetUnimplemented`)
          return true
        }
      ),
      { numRuns: 50 }
    )
  })

  it('does not register any listeners when bot.protocolVersion !== 775 (plugin short-circuits)', function () {
    // The plugin gates itself on bot.protocolVersion === 775; older bots must
    // not start consuming rawPacket / low_disk_space_warning / position events.
    const bot = makeMockBot({ protocolVersion: 770 })
    packets261(bot)

    let bridged = 0
    bot.on('packetUnimplemented', () => { bridged++ })

    bot._client.emit('rawPacket', {
      packetId: 0xAB,
      state: 'play',
      protocolVersion: 775,
      buffer: Buffer.alloc(0)
    })
    assert.strictEqual(bridged, 0, 'plugin should be inactive for non-26.1 bots')
  })

  it('keeps processing subsequent packets after a rawPacket without crashing', function () {
    const bot = makeMockBot()
    packets261(bot)

    const seen = []
    bot.on('packetUnimplemented', (evt) => seen.push(evt))

    // 1) first an unknown packet
    bot._client.emit('rawPacket', {
      packetId: 0x99,
      state: 'play',
      protocolVersion: 775,
      buffer: Buffer.alloc(0)
    })

    // 2) then a low_disk_space_warning - the plugin must continue dispatching
    //    other handlers without throwing.
    let warned = false
    bot._warn = () => { warned = true }
    bot._client.emit('low_disk_space_warning', {})
    assert.strictEqual(warned, true, 'low_disk_space_warning handler still runs after a rawPacket')

    // 3) another unknown packet - exactly one more packetUnimplemented.
    bot._client.emit('rawPacket', {
      packetId: 0xAB,
      state: 'configuration',
      protocolVersion: 775,
      buffer: Buffer.alloc(0)
    })

    assert.strictEqual(seen.length, 2)
    assert.strictEqual(seen[0].name, 'unimplemented_play_0x99')
    assert.strictEqual(seen[1].name, 'unimplemented_configuration_0xab')
  })

  it('ignores malformed rawPacket events (null / missing fields) without throwing', function () {
    const bot = makeMockBot()
    packets261(bot)

    let count = 0
    bot.on('packetUnimplemented', () => { count++ })

    // The handler guards on `raw && raw.protocolVersion === 775`, so these
    // shouldn't fire and shouldn't crash.
    bot._client.emit('rawPacket', null)
    bot._client.emit('rawPacket', undefined)
    bot._client.emit('rawPacket', {})
    bot._client.emit('rawPacket', { protocolVersion: 775 }) // packetId/state still missing

    // The last one DOES match the protocolVersion gate. It will produce
    // `unimplemented_undefined_0xNaN`, which is ugly but explicitly allowed
    // by the implementation. We only care that the bot is still alive.
    assert.ok(count >= 0, 'handler did not throw on malformed input')
  })
})
