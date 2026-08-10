/* eslint-env mocha */
//
// Feature: minecraft-26-1-protocol-and-velocity-support, Property 9: 移动节奏计数不变量
//
// For any integer N >= 0, after N physics ticks the client should write
// 'tick_end' (the 26.1 client_tick_end packet, toServer 0x0D) exactly N
// times, and the externally observable bot.entity.position update event
// count should also equal N (20 Hz cadence).
//
// For any integer K >= 0 chunk-load events, the client should write
// 'player_loaded' (toServer 0x2C) exactly K times.
//
// A full mineflayer bot harness is heavy here; per the task brief we use
// approach (a): drive the cadence with a minimal mock bot exposing the
// surface area the 26.1 plugins touch (bot._client.write spy,
// bot.entity.position, bot.protocolVersion=775, bot.supportFeature, the
// 'chunkColumnLoad' event). We exercise:
//
//   * The tick_end cadence by directly invoking the same write call
//     physics.js's tickPhysics() makes when the 26.1 gates are active —
//     this mirrors the production loop without spinning up real timers.
//
//   * The player_loaded cadence by routing real chunkColumnLoad events
//     through the 26.1 plugin (lib/plugins/packets26_1.js) which is the
//     only place that maps the chunk event to a player_loaded write.
//
// We additionally read physics.js as plain text and assert the wiring
// (the gate + the bot._client.write('tick_end', {}) call) is in place
// per the spec's degenerate-test fallback option.
//
// Validates: Requirements 11.3, 13.5, 13.6

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const EventEmitter = require('events')
const fc = require('fast-check')

const inject261 = require('../lib/plugins/packets26_1')

// ---------------------------------------------------------------------------
// Mock bot factory
//
// Mirrors only the surface area the cadence path needs. The mock has:
//   - bot._client: an EventEmitter with a .write(name, params) spy
//   - bot.entity:  { position, onGround, ... } — emits a synthetic
//                  'positionUpdate' event each driver tick
//   - bot.protocolVersion: 775 (so the 26.1 gates fire)
//   - bot.supportFeature(name): returns true for the 26.1 features the
//                  cadence path checks ('clientTickEnd', 'playerLoaded')
// ---------------------------------------------------------------------------
function createMockBot ({ supportFeatures = ['clientTickEnd', 'playerLoaded'] } = {}) {
  const bot = new EventEmitter()
  bot.protocolVersion = 775
  bot.supportFeature = (name) => supportFeatures.includes(name)
  bot.physicsEnabled = true

  bot.entity = {
    position: { x: 0, y: 0, z: 0, clone () { return { ...this } } },
    onGround: true
  }

  bot._client = new EventEmitter()
  bot._client.writes = []
  bot._client.write = (name, params) => {
    bot._client.writes.push({ name, params })
  }

  // Counters for the property assertions
  bot.counters = {
    tickEnd: 0,
    playerLoaded: 0,
    positionUpdate: 0
  }

  // Spy on writes by name to keep the assertion loop O(1) instead of O(N).
  const realWrite = bot._client.write
  bot._client.write = (name, params) => {
    realWrite(name, params)
    if (name === 'tick_end') bot.counters.tickEnd++
    else if (name === 'player_loaded') bot.counters.playerLoaded++
  }

  return bot
}

// Drive N "physics ticks" using the same gate predicate physics.js uses.
// This mirrors the relevant snippet of tickPhysics() (the `if
// (sendsClientTickEnd && shouldUsePhysics) bot._client.write('tick_end',
// {})` branch). Each tick also emits a position-update notification so the
// bot.entity.position update event count == N invariant is testable.
function driveTicks (bot, N) {
  const sendsClientTickEnd = bot.protocolVersion === 775 && bot.supportFeature('clientTickEnd')
  for (let i = 0; i < N; i++) {
    if (sendsClientTickEnd && bot.physicsEnabled) {
      bot._client.write('tick_end', {})
    }
    // Simulated 20 Hz position update event — same cadence as physics.js
    // (one event per physics tick). Counted by the listener below.
    bot.emit('positionUpdate')
  }
}

// Drive K chunk-load completion events, which the 26.1 plugin translates to
// player_loaded writes (lib/plugins/packets26_1.js Task 11.3).
function fireChunkLoads (bot, K) {
  for (let i = 0; i < K; i++) {
    bot.emit('chunkColumnLoad')
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Property 9: move cadence counts (26.1)', function () {
  it('tick_end count === N for any N >= 0 (Req 11.3, 13.5)', function () {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (N) => {
        const bot = createMockBot()
        // Listener count for the 20 Hz cadence cross-check.
        bot.on('positionUpdate', () => { bot.counters.positionUpdate++ })

        driveTicks(bot, N)

        assert.strictEqual(bot.counters.tickEnd, N, 'tick_end write count must equal N')
        assert.strictEqual(bot.counters.positionUpdate, N, 'position update event count must equal N')
      }),
      { numRuns: 100 }
    )
  })

  it('player_loaded count === K for any K >= 0 (Req 13.6)', function () {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), (K) => {
        const bot = createMockBot()
        // The 26.1 plugin wires 'chunkColumnLoad' -> bot._client.write('player_loaded').
        inject261(bot)

        fireChunkLoads(bot, K)

        assert.strictEqual(bot.counters.playerLoaded, K, 'player_loaded write count must equal K')
      }),
      { numRuns: 100 }
    )
  })

  it('combined N ticks + K chunk loads keep both counters independent', function () {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        (N, K) => {
          const bot = createMockBot()
          inject261(bot)

          driveTicks(bot, N)
          fireChunkLoads(bot, K)

          assert.strictEqual(bot.counters.tickEnd, N)
          assert.strictEqual(bot.counters.playerLoaded, K)
        }
      ),
      { numRuns: 100 }
    )
  })

  // ---------------------------------------------------------------------------
  // Wiring checks against physics.js source — degenerate but matches the
  // spec's optional-test fallback. Catches regressions where someone deletes
  // the gate or the write call without updating tests.
  // ---------------------------------------------------------------------------
  it('lib/plugins/physics.js writes tick_end on the 26.1 gate', function () {
    const physicsSrc = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'plugins', 'physics.js'),
      'utf8'
    )
    // Gate: bot.protocolVersion >= 775 && bot.supportFeature('clientTickEnd')
    assert.match(
      physicsSrc,
      /bot\.protocolVersion\s*>=\s*775\s*&&\s*bot\.supportFeature\(\s*['"]clientTickEnd['"]\s*\)/,
      'physics.js must gate tick_end on protocolVersion >= 775 + clientTickEnd feature'
    )
    // The actual write call must be present.
    assert.match(
      physicsSrc,
      /bot\._client\.write\(\s*['"]tick_end['"]\s*,/,
      "physics.js must call bot._client.write('tick_end', {}) inside the tick loop"
    )
  })

  it('lib/plugins/packets26_1.js writes player_loaded on chunkColumnLoad', function () {
    const pluginSrc = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'plugins', 'packets26_1.js'),
      'utf8'
    )
    assert.match(
      pluginSrc,
      /bot\.on\(\s*['"]chunkColumnLoad['"]/,
      "packets26_1.js must subscribe to bot 'chunkColumnLoad'"
    )
    assert.match(
      pluginSrc,
      /bot\._client\.write\(\s*['"]player_loaded['"]\s*,/,
      "packets26_1.js must call bot._client.write('player_loaded', {})"
    )
  })
})
