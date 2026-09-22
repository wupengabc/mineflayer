/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const injectAnyEvent = require('../lib/any_event')

function createEmitter () {
  const emitter = new EventEmitter()
  injectAnyEvent(emitter)
  return emitter
}

describe('onAny / offAny', function () {
  it('receives the event name followed by the original arguments', function () {
    const bot = createEmitter()
    const seen = []
    bot.onAny((event, ...args) => seen.push([event, args]))

    bot.emit('chat', 'alice', 'hello')
    bot.emit('spawn')

    assert.deepStrictEqual(seen, [
      ['chat', ['alice', 'hello']],
      ['spawn', []]
    ])
  })

  it('does not disturb regular listeners', function () {
    const bot = createEmitter()
    const order = []
    bot.on('thing', (a) => order.push(['on', a]))
    bot.onAny((event, a) => order.push(['onAny', event, a]))

    bot.emit('thing', 1)

    // Regular listeners run first, observers see post-dispatch state.
    assert.deepStrictEqual(order, [
      ['on', 1],
      ['onAny', 'thing', 1]
    ])
  })

  it('still supports once semantics on the wrapped emitter', function () {
    const bot = createEmitter()
    let calls = 0
    bot.once('thing', () => { calls++ })

    bot.emit('thing')
    bot.emit('thing')

    assert.strictEqual(calls, 1)
  })

  it('skips newListener and removeListener meta events', function () {
    const bot = createEmitter()
    const seen = []
    bot.onAny((event) => seen.push(event))

    bot.on('thing', () => {})
    bot.off('thing', () => {})
    bot.emit('thing')

    assert.deepStrictEqual(seen, ['thing'])
  })

  it('delivers to every registered listener in registration order', function () {
    const bot = createEmitter()
    const order = []
    bot.onAny(() => order.push('first'))
    bot.onAny(() => order.push('second'))

    bot.emit('thing')

    assert.deepStrictEqual(order, ['first', 'second'])
  })

  it('binds this to the bot', function () {
    const bot = createEmitter()
    bot.marker = 'bot-instance'
    let self = null
    bot.onAny(function () { self = this })

    bot.emit('thing')

    assert.strictEqual(self, bot)
  })

  it('onAny returns a function that unsubscribes the listener', function () {
    const bot = createEmitter()
    const seen = []
    const unsubscribe = bot.onAny((event) => seen.push(event))

    bot.emit('one')
    unsubscribe()
    bot.emit('two')

    assert.deepStrictEqual(seen, ['one'])
  })

  it('offAny removes a listener and reports whether it was registered', function () {
    const bot = createEmitter()
    const seen = []
    const listener = (event) => seen.push(event)

    bot.onAny(listener)
    assert.strictEqual(bot.offAny(listener), true)
    assert.strictEqual(bot.offAny(listener), false)
    bot.emit('thing')

    assert.deepStrictEqual(seen, [])
  })

  it('accepts function listeners and rejects anything else', function () {
    const bot = createEmitter()
    assert.throws(() => bot.onAny('not a function'), TypeError)
    assert.throws(() => bot.offAny(undefined), TypeError)
  })

  it('tolerates a listener that unsubscribes during dispatch', function () {
    const bot = createEmitter()
    const seen = []
    const second = () => seen.push('second')
    bot.onAny(() => {
      seen.push('first')
      bot.offAny(second)
    })
    bot.onAny(second)

    bot.emit('thing')

    // The snapshot for this emit is unaffected by the removal.
    assert.deepStrictEqual(seen, ['first', 'second'])

    bot.emit('other')
    assert.deepStrictEqual(seen, ['first', 'second', 'first'])
  })

  it('is a no-op fast path when nothing is registered', function () {
    const bot = createEmitter()
    let calls = 0
    bot.on('thing', () => { calls++ })

    bot.emit('thing')

    assert.strictEqual(calls, 1)
  })

  it('propagates a throwing regular listener but still notifies observers', function () {
    const bot = createEmitter()
    const seen = []
    bot.on('thing', () => { throw new Error('boom') })
    bot.onAny((event) => seen.push(event))

    assert.throws(() => bot.emit('thing'), /boom/)
    assert.deepStrictEqual(seen, ['thing'])
  })
})
