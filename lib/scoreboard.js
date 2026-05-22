const sortItems = (a, b) => {
  if (a.value > b.value) return -1
  if (a.value < b.value) return 1
  return 1
}

module.exports = (bot) => {
  const ChatMessage = require('prismarine-chat')(bot.registry)

  class ScoreBoard {
    constructor (packet) {
      this.name = packet.name
      this.setTitle(packet.displayText)
      this.itemsMap = {}
    }

    setTitle (title) {
      if (title === undefined || title === null) {
        this.title = ''
        return
      }
      // 1.20.3+: displayText is an NBT chat component object (already parsed by NMP)
      if (typeof title === 'object') {
        try {
          // Simplify the NBT structure: { type: 'string', value: 'foo' } -> 'foo'
          //                             { type: 'compound', value: { text: {type:'string',value:'foo'} } } -> { text: 'foo' }
          const nbt = require('prismarine-nbt')
          const simplified = nbt.simplify(title)
          // simplified is now either a string or a chat component object
          this.title = new ChatMessage(simplified).toString()
        } catch {
          // Fallback: try common shapes
          if (title.value && typeof title.value === 'string') {
            this.title = title.value
          } else if (title.text) {
            this.title = typeof title.text === 'object' ? (title.text.value || '') : title.text
          } else {
            this.title = ''
          }
        }
        return
      }
      // Pre-1.20.3: displayText is a JSON string
      try {
        this.title = JSON.parse(title).text
      } catch {
        this.title = title
      }
    }

    add (name, value, extras) {
      const explicitDisplay = extras && extras.displayName != null ? extras.displayName : null
      const numberFormat = extras ? extras.numberFormat : undefined
      const styling = extras ? extras.styling : undefined

      // Pre-resolve the explicit display name (if the server sent one) into a
      // ChatMessage so consumers can call .toString() / .toHTML() / .toAnsi().
      // Falls back gracefully when the value is malformed NBT.
      let prebuiltDisplay = null
      if (explicitDisplay !== null && explicitDisplay !== undefined) {
        try {
          const nbt = require('prismarine-nbt')
          // anonymousNbt that decodes as compound/list/string -> simplify to a JS object
          const simplified = (typeof explicitDisplay === 'object' && explicitDisplay.type)
            ? nbt.simplify(explicitDisplay)
            : explicitDisplay
          prebuiltDisplay = new ChatMessage(simplified)
        } catch {
          prebuiltDisplay = null
        }
      }

      this.itemsMap[name] = {
        name,
        value,
        numberFormat,
        styling,
        displayNameRaw: explicitDisplay,
        get displayName () {
          // Priority 1: server-supplied display_name (1.20.3+)
          if (prebuiltDisplay) return prebuiltDisplay
          // Priority 2: team-decorated display name (TAB-style sidebars)
          if (name in bot.teamMap) {
            return bot.teamMap[name].displayName(name)
          }
          // Priority 3: plain owner string
          return new ChatMessage(name)
        }
      }
      return this.itemsMap[name]
    }

    remove (name) {
      const removed = this.itemsMap[name]
      delete this.itemsMap[name]
      return removed
    }

    get items () {
      return Object.values(this.itemsMap).sort(sortItems)
    }
  }

  ScoreBoard.positions = {
    get list () {
      return this[0]
    },

    get sidebar () {
      return this[1]
    },

    get belowName () {
      return this[2]
    }
  }
  return ScoreBoard
}
