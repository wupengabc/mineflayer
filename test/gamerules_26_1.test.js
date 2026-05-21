/* eslint-env mocha */
'use strict'

// Property 11: game_rule_values 派发即同步
//
// For any client-bound game_rule_values packet with rules: array<{name, value}>:
//   * After dispatch, bot.game.gameRules equals the dictionary form of `rules`
//     (last-write-wins on duplicate names).
//   * The 'gameRulesUpdated' event fires exactly once per packet.
//   * The event payload equals that same dictionary.
//
// Validates: Requirements 11.4

const assert = require('assert')
const EventEmitter = require('events')
const fc = require('fast-check')

const gamePluginInject = require('../lib/plugins/game.js')

// ---------------------------------------------------------------------------
// Mock bot factory.
//
// game.js' inject() touches:
//   * bot._client (an EventEmitter that also has .registerChannel & .on)
//   * bot.supportFeature(name)            -> branch on customChannelIdentifier
//   * bot.registry.loadDimensionCodec()   -> only fires on registry_data/login
//   * bot.emit / bot.on                   -> bot must be an EventEmitter
//
// We only need the parts that the game_rule_values handler exercises. The
// brand-channel registration and login/respawn handlers are wired up by inject()
// but never triggered in this test, so a minimal stub is enough.
// ---------------------------------------------------------------------------
function makeMockBot () {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.registerChannel = () => {}
  bot._client.writeChannel = () => {}
  bot.registry = {
    loadDimensionCodec: () => {}
  }
  // game.js calls bot.supportFeature() to pick the brand-channel name when
  // building the inject closure. Returning the post-1.13 channel id keeps the
  // call non-throwing without emitting any packets.
  bot.supportFeature = (name) => name === 'customChannelIdentifier'
  return bot
}

// Build the dictionary the inject handler is supposed to produce: last write
// wins per name. Mirrors the production loop so the test stays a pure
// reference oracle rather than a copy of the implementation.
function expectedDict (rules) {
  const out = {}
  for (const rule of rules) {
    if (rule == null) continue
    out[rule.name] = rule.value
  }
  return out
}

// fast-check arbitrary for a single { name, value } rule.
//
// Names: short ASCII identifiers - the protocol uses snake_case rule names
// (e.g. doDaylightCycle, keepInventory). Values can be strings, integers, or
// booleans depending on the rule, so we generate the union to avoid baking in
// any one shape.
const ruleArb = fc.record({
  name: fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/),
  value: fc.oneof(
    fc.string({ maxLength: 32 }),
    fc.integer(),
    fc.boolean()
  )
})

const rulesArrayArb = fc.array(ruleArb, { maxLength: 16 })

describe('packets26_1 game_rule_values dispatch (Property 11)', function () {
  this.timeout(15000)

  it('dictionarizes rules, fires gameRulesUpdated exactly once, and payload equals dict', function () {
    fc.assert(
      fc.property(rulesArrayArb, (rules) => {
        const bot = makeMockBot()
        // game.js' inject expects an options bag with .brand for the brand
        // channel write. The brand write only fires on 'login', so any value
        // is fine here, but we still pass one to avoid surprise property
        // accesses.
        gamePluginInject(bot, { brand: 'mineflayer' })

        let eventCount = 0
        let lastPayload
        bot.on('gameRulesUpdated', (payload) => {
          eventCount++
          lastPayload = payload
        })

        bot._client.emit('game_rule_values', { rules })

        const expected = expectedDict(rules)

        // 1) bot.game.gameRules equals the dictionary form (last-write-wins).
        assert.deepStrictEqual(bot.game.gameRules, expected)
        // 2) 'gameRulesUpdated' fired exactly once for this single packet.
        assert.strictEqual(eventCount, 1)
        // 3) Event payload equals the dictionary - same reference is fine,
        //    but we compare by value to keep the assertion implementation
        //    independent.
        assert.deepStrictEqual(lastPayload, expected)
      }),
      { numRuns: 100 }
    )
  })

  it('handles repeated dispatch: each packet fires the event exactly once and merges into bot.game.gameRules', function () {
    fc.assert(
      fc.property(fc.array(rulesArrayArb, { minLength: 1, maxLength: 5 }), (packets) => {
        const bot = makeMockBot()
        gamePluginInject(bot, { brand: 'mineflayer' })

        let eventCount = 0
        const seenPayloads = []
        bot.on('gameRulesUpdated', (payload) => {
          eventCount++
          // Snapshot the payload by value because the production handler
          // emits a reference to bot.game.gameRules which is mutated on
          // subsequent packets.
          seenPayloads.push({ ...payload })
        })

        // The merged-state oracle: rules accumulate across packets, with
        // last-write-wins both within and between packets.
        const merged = {}
        for (const rules of packets) {
          bot._client.emit('game_rule_values', { rules })
          for (const rule of rules) {
            if (rule == null) continue
            merged[rule.name] = rule.value
          }
        }

        // One event per packet, regardless of how many or how few rules.
        assert.strictEqual(eventCount, packets.length)
        // bot.game.gameRules reflects the cumulative merge.
        assert.deepStrictEqual(bot.game.gameRules, merged)
        // The most recent payload mirrors bot.game.gameRules at that point.
        assert.deepStrictEqual(seenPayloads[seenPayloads.length - 1], merged)
      }),
      { numRuns: 50 }
    )
  })

  it('treats missing/null rules array defensively (no throw, empty dict)', function () {
    const bot = makeMockBot()
    gamePluginInject(bot, { brand: 'mineflayer' })

    let eventCount = 0
    bot.on('gameRulesUpdated', () => { eventCount++ })

    // packet without a `rules` field at all
    bot._client.emit('game_rule_values', {})
    assert.deepStrictEqual(bot.game.gameRules, {})
    assert.strictEqual(eventCount, 1)

    // packet with rules: null
    bot._client.emit('game_rule_values', { rules: null })
    assert.deepStrictEqual(bot.game.gameRules, {})
    assert.strictEqual(eventCount, 2)
  })
})
