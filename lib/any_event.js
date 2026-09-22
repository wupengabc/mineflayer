'use strict'

// Wildcard event observation.
//
// Node's EventEmitter has no wildcard support, so `bot.emit` is wrapped: the
// normal dispatch runs first (regular listeners and `once` bookkeeping are
// untouched), then every onAny listener is called with the event name followed
// by the original arguments.
//
//   const unsubscribe = bot.onAny((event, ...args) => { ... })
//   bot.offAny(listener)          // true if it was registered
//   unsubscribe()                 // same thing
//
// Listeners are invoked with `this` bound to the bot, like any other emitter
// listener, and run in registration order. The listener set is snapshotted per
// emit, so a listener may register or remove listeners without affecting the
// dispatch already in progress.
//
// Meta events ('newListener' / 'removeListener') are skipped: they fire as
// bookkeeping whenever listeners are added or removed and would otherwise spam
// observers (including onAny registrations themselves).
//
// Observers are notified after the regular listeners for the same event, so
// they see post-update bot state. They are also notified when a regular
// listener threw, or when 'error' was emitted with no 'error' listener: `emit`
// rethrows that failure afterwards, exactly as it would without onAny.
//
// A listener must not emit the event it is observing, which would recurse.

module.exports = inject

const META_EVENTS = new Set(['newListener', 'removeListener'])

function inject (bot) {
  const listeners = new Set()
  const emit = bot.emit.bind(bot)

  bot.emit = function (event, ...args) {
    let result
    try {
      result = emit(event, ...args)
    } finally {
      if (listeners.size !== 0 && !META_EVENTS.has(event)) {
        for (const listener of [...listeners]) {
          listener.call(bot, event, ...args)
        }
      }
    }
    return result
  }

  bot.onAny = function (listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('onAny listener must be a function')
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  bot.offAny = function (listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('offAny listener must be a function')
    }
    return listeners.delete(listener)
  }
}
