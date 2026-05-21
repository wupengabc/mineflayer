/* eslint-env mocha */
'use strict'

// Cross-version Velocity smoke: re-run the same Velocity modern-forwarding
// path against a 1.21.x backend (instead of paper-26-1.2) to confirm the
// Velocity code path is decoupled from the 26.1 protocol changes.
//
// This test only runs when a 1.21.x backend is wired into the
// docker-compose stack. The current docker-compose.26-1.yml only exposes
// the paper-26-1.2 backend, so by default we skip with a documented
// reason. To actually run this test, set LEGACY_VELOCITY_BACKEND=1
// (and ensure your compose stack exposes a Velocity proxy fronting a
// 1.21.x Paper/vanilla backend on $LEGACY_VELOCITY_HOST:$LEGACY_VELOCITY_PORT).
//
// Validates: Requirements 14.5

const assert = require('assert')
const mineflayer = require('mineflayer')

const ENABLED = process.env.LEGACY_VELOCITY_BACKEND === '1' ||
  process.env.LEGACY_VELOCITY_BACKEND === 'true'

const HOST = process.env.LEGACY_VELOCITY_HOST || '127.0.0.1'
const PORT = Number.parseInt(process.env.LEGACY_VELOCITY_PORT || '25577', 10)
const VERSION = process.env.LEGACY_VELOCITY_VERSION || '1.21.4'
const VELOCITY_SECRET = process.env.LEGACY_VELOCITY_SECRET ||
  'test-forwarding-secret-32-chars-x'

describe('26.1 smoke: Velocity forwarding still works for 1.21.x backends', function () {
  this.timeout(120000)

  let bot = null

  before(function () {
    if (!ENABLED) {
      // Default docker-compose.26-1.yml does not include a 1.21.x
      // backend, so skip rather than fail. Operators who want to run
      // this case must opt in via LEGACY_VELOCITY_BACKEND=1 and stand
      // up an additional Velocity+1.21.x stack themselves.
      this.skip()
    }
  })

  afterEach(function (done) {
    if (!bot) return done()
    const b = bot
    bot = null
    try {
      b.removeAllListeners('error')
      b.removeAllListeners('end')
      b.once('end', () => done())
      b.quit()
      setTimeout(() => done(), 2000).unref()
    } catch (_) {
      done()
    }
  })

  // Documented as it.skip-able boilerplate: the suite-level before() will
  // skip the entire suite unless LEGACY_VELOCITY_BACKEND is set.
  it(`completes 'login' within 30s against ${VERSION}`, function (done) {
    bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username: 'legacyvel',
      version: VERSION,
      auth: 'offline',
      velocityForwardingSecret: VELOCITY_SECRET,
      velocityForwardingVersion: 1,
      checkTimeoutInterval: 60 * 1000
    })

    let finished = false
    const startedAt = Date.now()

    const loginTimer = setTimeout(() => {
      finish(new Error(`'login' did not fire within 30s for version ${VERSION}`))
    }, 30 * 1000)

    function finish (err) {
      if (finished) return
      finished = true
      clearTimeout(loginTimer)
      done(err)
    }

    bot.once('error', (err) => {
      if (err && err.code === 'ECONNREFUSED') {
        finished = true
        clearTimeout(loginTimer)
        this.skip()
        return
      }
      finish(err)
    })

    bot.once('login', () => {
      const elapsed = Date.now() - startedAt
      try {
        assert.ok(elapsed < 30 * 1000, `login fired at ${elapsed}ms, want < 30000ms`)
      } catch (e) {
        return finish(e)
      }
      finish()
    })
  })
})
