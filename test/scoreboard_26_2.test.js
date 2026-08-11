'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const protocol = require('minecraft-protocol')
const injectScoreboard = require('../lib/plugins/scoreboard')
const injectTeams = require('../lib/plugins/team')

function makeBot () {
  const bot = new EventEmitter()
  bot.registry = require('prismarine-registry')('26.2')
  bot.supportFeature = bot.registry.supportFeature
  bot._client = new EventEmitter()
  bot._warn = () => {}
  injectTeams(bot)
  injectScoreboard(bot)
  return bot
}

describe('26.2 scoreboard', function () {
  it('creates and updates a scoreboard from 26.2 packets', function () {
    const bot = makeBot()

    bot._client.emit('scoreboard_objective', {
      name: 'objective',
      action: 0,
      displayText: { type: 'string', value: 'Title' },
      type: 0
    })
    bot._client.emit('scoreboard_score', {
      itemName: 'player',
      scoreName: 'objective',
      value: 7
    })
    bot._client.emit('scoreboard_display_objective', {
      position: 1,
      name: 'objective'
    })

    assert.strictEqual(bot.scoreboards.objective.title, 'Title')
    assert.strictEqual(bot.scoreboards.objective.itemsMap.player.value, 7)
    assert.strictEqual(bot.scoreboard.sidebar, bot.scoreboards.objective)
  })

  it('supports the official 26.2 scoreboard packet field names', function () {
    const bot = makeBot()

    bot._client.emit('set_objective', {
      objectiveName: 'objective',
      method: 'add',
      displayName: { type: 'string', value: 'Title' }
    })
    bot._client.emit('set_score', {
      owner: 'player',
      objectiveName: 'objective',
      score: 9
    })
    bot._client.emit('set_display_objective', {
      slot: 1,
      objectiveName: 'objective'
    })

    assert.strictEqual(bot.scoreboards.objective.title, 'Title')
    assert.strictEqual(bot.scoreboards.objective.name, 'objective')
    assert.strictEqual(bot.scoreboards.objective.itemsMap.player.value, 9)
    assert.strictEqual(bot.scoreboard.sidebar, bot.scoreboards.objective)
  })

  it('uses 26.2 teams flags and decoration for scoreboard entries', function () {
    const bot = makeBot()
    const rawTeams = Buffer.from(
      '6d0467637a410008000467637a410800000800000001010f01010367637a',
      'hex'
    )
    const deserializer = protocol.createDeserializer({
      state: 'play',
      version: '26.2',
      isServer: false,
      noErrorLogging: true
    })
    const teamPacket = deserializer.parsePacketBuffer(rawTeams).data.params

    bot._client.emit('teams', teamPacket)
    bot._client.emit('scoreboard_objective', {
      name: 'objective',
      action: 0,
      displayText: { type: 'string', value: 'Title' },
      type: 0
    })
    bot._client.emit('scoreboard_score', {
      itemName: 'gcz',
      scoreName: 'objective',
      value: 7
    })

    assert.strictEqual(bot.teams.gczA.friendlyFire, true)
    assert.strictEqual(bot.teamMap.gcz, bot.teams.gczA)
    assert.strictEqual(bot.scoreboards.objective.itemsMap.gcz.displayName.toString(), 'gcz')
  })

  it('clears a display slot when the server sends an empty objective name', function () {
    const bot = makeBot()
    const positions = []
    bot.on('scoreboardPosition', (position, scoreboard, previous) => {
      positions.push({ position, scoreboard, previous })
    })

    bot._client.emit('scoreboard_objective', {
      name: 'objective',
      action: 0,
      displayText: { type: 'string', value: 'Title' },
      type: 0
    })
    bot._client.emit('scoreboard_display_objective', { position: 1, name: 'objective' })
    bot._client.emit('scoreboard_display_objective', { position: 1, name: '' })

    assert.strictEqual(bot.scoreboard.sidebar, undefined)
    assert.strictEqual(positions.length, 2)
    assert.strictEqual(positions[1].scoreboard, undefined)
    assert.strictEqual(positions[1].previous.name, 'objective')
  })

  it('applies a display position that arrives before its objective', function () {
    const bot = makeBot()

    bot._client.emit('scoreboard_display_objective', { position: 1, name: 'objective' })
    assert.strictEqual(bot.scoreboard.sidebar, undefined)

    bot._client.emit('scoreboard_objective', {
      name: 'objective',
      action: 0,
      displayText: { type: 'string', value: 'Title' },
      type: 0
    })

    assert.strictEqual(bot.scoreboard.sidebar, bot.scoreboards.objective)
  })

  it('does not apply a cleared pending display position later', function () {
    const bot = makeBot()

    bot._client.emit('scoreboard_display_objective', { position: 1, name: 'objective' })
    bot._client.emit('scoreboard_display_objective', { position: 1, name: '' })
    bot._client.emit('scoreboard_objective', {
      name: 'objective',
      action: 0,
      displayText: { type: 'string', value: 'Title' },
      type: 0
    })

    assert.strictEqual(bot.scoreboard.sidebar, undefined)
  })
})
