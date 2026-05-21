/* eslint-env mocha */
'use strict'

// End-to-end physics-alignment smoke: walk forward for 5 seconds against a
// real PaperMC 26.1.2 backend and verify the server never sends a
// 'serverPositionCorrection' (which would mean Paper's anti-cheat / move
// validator disagrees with our client-side physics).
//
// Validates: Requirements 12.1, 12.7

const assert = require('assert')
const mineflayer = require('mineflayer')

const HOST = process.env.MC_INTEGRATION_HOST || '127.0.0.1'
const PORT = Number.parseInt(process.env.MC_INTEGRATION_PORT || '25577', 10)
const VERSION = '26.1.2'
const VELOCITY_SECRET = 'test-forwarding-secret-32-chars-x'

const WALK_DURATION_MS = 5 * 1000

describe('26.1 smoke: walking forward triggers no server correction', function () {
  this.timeout(120000)

  let bot = null

  afterEach(function (done) {
    if (!bot) return done()
    const b = bot
    bot = null
    try {
      b.removeAllListeners('error')
      b.removeAllListeners('end')
      try { b.setControlState('forward', false) } catch (_) { /* ignore */ }
      b.once('end', () => done())
      b.quit()
      setTimeout(() => done(), 2000).unref()
    } catch (_) {
      done()
    }
  })

  it('emits zero serverPositionCorrection events while walking forward 5s', function (done) {
    bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username: 'walker261',
      version: VERSION,
      auth: 'offline',
      velocityForwardingSecret: VELOCITY_SECRET,
      velocityForwardingVersion: 1,
      checkTimeoutInterval: 60 * 1000
    })

    let finished = false
    const corrections = []

    function finish (err) {
      if (finished) return
      finished = true
      done(err)
    }

    bot.once('error', (err) => {
      if (err && err.code === 'ECONNREFUSED') {
        finished = true
        this.skip()
        return
      }
      finish(err)
    })

    // Capture every correction the server pushes during the walk window.
    bot.on('serverPositionCorrection', (info) => {
      corrections.push(info)
    })

    // Spawn timeout: if we never spawn, fail with a clear message rather
    // than letting mocha's outer timeout fire.
    const spawnTimer = setTimeout(() => {
      finish(new Error("'spawn' did not fire within 60s"))
    }, 60 * 1000)

    bot.once('spawn', () => {
      clearTimeout(spawnTimer)

      // Drive the player forward for the configured walk window.
      try {
        bot.setControlState('forward', true)
      } catch (e) {
        return finish(e)
      }

      setTimeout(() => {
        try {
          bot.setControlState('forward', false)
        } catch (_) { /* ignore */ }

        try {
          assert.strictEqual(
            corrections.length,
            0,
            'expected zero server position corrections during a 5s forward walk, ' +
              `got ${corrections.length}: ${JSON.stringify(corrections.slice(0, 3))}`
          )
        } catch (e) {
          return finish(e)
        }
        finish()
      }, WALK_DURATION_MS)
    })
  })
})
