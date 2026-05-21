/* eslint-env mocha */
'use strict'

// End-to-end smoke: Velocity (modern forwarding) -> Paper 26.1.2.
//
// This test only runs when the docker-compose stack from
// test/integration/docker-compose.26-1.yml is up and reachable on
// localhost:25577. It is invoked by `npm run test:integration:26-1`,
// which brings the stack up first via wait-for-port.js.
//
// Validates: Requirements 11.1, 11.2

const assert = require('assert')
const mineflayer = require('mineflayer')

// docker-compose.26-1.yml maps the Velocity proxy to host port 25577.
const HOST = process.env.MC_INTEGRATION_HOST || '127.0.0.1'
const PORT = Number.parseInt(process.env.MC_INTEGRATION_PORT || '25577', 10)
const VERSION = '26.1.2'

// Must match the secret pinned in test/integration/forwarding.secret and
// in test/integration/paper-overlay/config/paper-global.yml. Velocity
// trims trailing whitespace from the file, so the bot ships the bare
// 32-char string here.
const VELOCITY_SECRET = 'test-forwarding-secret-32-chars-x'

describe('26.1 smoke: login + spawn through Velocity', function () {
  // The whole suite is bounded by mocha's per-suite timeout. Login alone
  // can take 20+ seconds against a cold Paper world, so we go wide.
  this.timeout(120000)

  let bot = null

  afterEach(function (done) {
    if (!bot) return done()
    const b = bot
    bot = null
    try {
      b.removeAllListeners('error')
      b.removeAllListeners('end')
      b.once('end', () => done())
      b.quit()
      // Fallback in case 'end' never fires (e.g., socket already dead).
      setTimeout(() => done(), 2000).unref()
    } catch (_) {
      done()
    }
  })

  it('completes login within 30s and spawns within 60s', function (done) {
    bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username: 'smoke261',
      version: VERSION,
      auth: 'offline',
      velocityForwardingSecret: VELOCITY_SECRET,
      velocityForwardingVersion: 1,
      checkTimeoutInterval: 60 * 1000
    })

    let loginAt = null
    let spawnAt = null
    const startedAt = Date.now()

    const loginTimer = setTimeout(() => {
      if (loginAt === null) {
        finish(new Error("'login' did not fire within 30s"))
      }
    }, 30 * 1000)
    const spawnTimer = setTimeout(() => {
      if (spawnAt === null) {
        finish(new Error("'spawn' did not fire within 60s"))
      }
    }, 60 * 1000)

    let finished = false
    function finish (err) {
      if (finished) return
      finished = true
      clearTimeout(loginTimer)
      clearTimeout(spawnTimer)
      done(err)
    }

    bot.once('error', (err) => {
      // ECONNREFUSED on the very first connect attempt means the docker
      // stack isn't running. Skip rather than fail the suite.
      if (loginAt === null && err && err.code === 'ECONNREFUSED') {
        clearTimeout(loginTimer)
        clearTimeout(spawnTimer)
        finished = true
        this.skip()
        return
      }
      finish(err)
    })

    bot.once('login', () => {
      loginAt = Date.now() - startedAt
      assert.ok(loginAt < 30 * 1000, `login fired at ${loginAt}ms, want < 30000ms`)
    })

    bot.once('spawn', () => {
      spawnAt = Date.now() - startedAt
      try {
        assert.ok(loginAt !== null, "'login' must fire before 'spawn'")
        assert.ok(spawnAt < 60 * 1000, `spawn fired at ${spawnAt}ms, want < 60000ms`)
      } catch (e) {
        return finish(e)
      }
      finish()
    })
  })
})
