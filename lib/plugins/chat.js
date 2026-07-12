const { onceWithCleanup } = require('../promise_utils')

const USERNAME_REGEX = '(?:\\(.{1,15}\\)|\\[.{1,15}\\]|.){0,5}?(\\w+)'
const LEGACY_VANILLA_CHAT_REGEX = new RegExp(`^${USERNAME_REGEX}\\s?[>:\\-»\\]\\)~]+\\s(.*)$`)

module.exports = inject

function inject (bot, options) {
  const CHAT_LENGTH_LIMIT = options.chatLengthLimit ?? (bot.supportFeature('lessCharsInChat') ? 100 : 256)
  const defaultChatPatterns = options.defaultChatPatterns ?? true

  const ChatMessage = require('prismarine-chat')(bot.registry)
  // chat.pattern.type will emit an event for bot.on() of the same type, eg chatType = whisper will trigger bot.on('whisper')
  const _patterns = {}
  let _length = 0
  // deprecated
  bot.chatAddPattern = (patternValue, typeValue) => {
    return bot.addChatPattern(typeValue, patternValue, { deprecated: true })
  }

  bot.addChatPatternSet = (name, patterns, opts = {}) => {
    if (!patterns.every(p => p instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, parse = false } = opts
    _patterns[_length++] = {
      name,
      patterns,
      position: 0,
      matches: [],
      messages: [],
      repeat,
      parse
    }
    return _length
  }

  bot.addChatPattern = (name, pattern, opts = {}) => {
    if (!(pattern instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, deprecated = false, parse = false } = opts
    _patterns[_length] = {
      name,
      patterns: [pattern],
      position: 0,
      matches: [],
      messages: [],
      deprecated,
      repeat,
      parse
    }
    return _length++ // increment length after we give it back to the user
  }

  bot.removeChatPattern = name => {
    if (typeof name === 'number') {
      _patterns[name] = undefined
    } else {
      const matchingPatterns = Object.entries(_patterns).filter(pattern => pattern[1]?.name === name)
      matchingPatterns.forEach(([indexString]) => {
        _patterns[+indexString] = undefined
      })
    }
  }

  function findMatchingPatterns (msg) {
    const found = []
    for (const [indexString, pattern] of Object.entries(_patterns)) {
      if (!pattern) continue
      const { position, patterns } = pattern
      if (patterns[position].test(msg)) {
        found.push(+indexString)
      }
    }
    return found
  }

  bot.on('messagestr', (msg, _, originalMsg) => {
    const foundPatterns = findMatchingPatterns(msg)

    for (const ix of foundPatterns) {
      _patterns[ix].matches.push(msg)
      _patterns[ix].messages.push(originalMsg)
      _patterns[ix].position++

      if (_patterns[ix].deprecated) {
        const [, ...matches] = _patterns[ix].matches[0].match(_patterns[ix].patterns[0])
        bot.emit(_patterns[ix].name, ...matches, _patterns[ix].messages[0].translate, ..._patterns[ix].messages)
        _patterns[ix].messages = [] // clear out old messages
      } else { // regular parsing
        if (_patterns[ix].patterns.length > _patterns[ix].matches.length) return // we have all the matches, so we can emit the done event
        if (_patterns[ix].parse) {
          const matches = _patterns[ix].patterns.map((pattern, i) => {
            const [, ...matches] = _patterns[ix].matches[i].match(pattern) // delete full message match
            return matches
          })
          bot.emit(`chat:${_patterns[ix].name}`, matches)
        } else {
          bot.emit(`chat:${_patterns[ix].name}`, _patterns[ix].matches)
        }
        // these are possibly null-ish if the user deletes them as soon as the event for the match is emitted
      }
      if (_patterns[ix]?.repeat) {
        _patterns[ix].position = 0
        _patterns[ix].matches = []
      } else {
        _patterns[ix] = undefined
      }
    }
  })

  addDefaultPatterns()

  bot._client.on('playerChat', (data) => {
    const message = data.formattedMessage
    const verified = data.verified
    let msg
    if (bot.supportFeature('clientsideChatFormatting')) {
      const parameters = {
        sender: data.senderName ? JSON.parse(data.senderName) : undefined,
        target: data.targetName ? JSON.parse(data.targetName) : undefined,
        content: message ? JSON.parse(message) : { text: data.plainMessage }
      }
      // Handle both registry reference ({ chatType: id }) and inline data ({ data: { chat, narration } })
      const chatTypeData = data.type
      let registryIndex
      if (chatTypeData != null && chatTypeData.chatType != null) {
        // Registry reference: look up by ID
        registryIndex = chatTypeData.chatType
        msg = ChatMessage.fromNetwork(registryIndex, parameters)

        if (data.unsignedContent) {
          msg.unsigned = ChatMessage.fromNetwork(registryIndex, { sender: parameters.sender, target: parameters.target, content: JSON.parse(data.unsignedContent) })
        }
      } else if (chatTypeData != null && chatTypeData.data != null) {
        // Inline chat type data: construct directly from the decoration
        const decoration = chatTypeData.data.chat
        const formatString = bot.registry.language?.[decoration.translationKey] || decoration.translationKey
        msg = new ChatMessage({ translate: formatString, with: decoration.parameters.map(p => parameters[p] || '') })

        if (data.unsignedContent) {
          msg.unsigned = new ChatMessage({ translate: formatString, with: decoration.parameters.map(p => parameters[p] || '') })
        }
      } else {
        // Fallback: try registry lookup with the type value as-is
        msg = ChatMessage.fromNetwork(chatTypeData, parameters)
      }
    } else {
      msg = ChatMessage.fromNotch(message)
    }
    bot.emit('message', msg, 'chat', data.sender ?? null, verified)
    bot.emit('messagestr', msg.toString(), 'chat', msg, data.sender ?? null, verified)
  })

  // Walk a ChatMessage's JSON tree to find a `player` selector component
  // (e.g. {"player":{"name":"Steve"}}). Returns the player name or null.
  function extractPlayerName (jsonObj) {
    if (!jsonObj || typeof jsonObj !== 'object') return null
    if (jsonObj.player && jsonObj.player.name) return jsonObj.player.name
    if (Array.isArray(jsonObj.extra)) {
      for (const child of jsonObj.extra) {
        const name = extractPlayerName(child)
        if (name) return name
      }
    }
    if (Array.isArray(jsonObj.with)) {
      for (const child of jsonObj.with) {
        const name = extractPlayerName(child)
        if (name) return name
      }
    }
    return null
  }

  // Look up a player's UUID by username from the bot's player list
  function lookupUuidByUsername (username) {
    if (!username) return null
    // bot.players maps username -> { uuid, ... }
    if (bot.players && bot.players[username]) {
      return bot.players[username].uuid || null
    }
    // Fallback: search uuidToUsername (uuid -> username) for a match
    if (bot.uuidToUsername) {
      for (const [uuid, name] of Object.entries(bot.uuidToUsername)) {
        if (name === username) return uuid
      }
    }
    return null
  }

  bot._client.on('systemChat', (data) => {
    const msg = ChatMessage.fromNotch(data.formattedMessage)
    const chatPositions = {
      1: 'system',
      2: 'game_info'
    }
    const position = chatPositions[data.positionId] || 'system'

    // Paper/Velocity proxy servers often send player chat as systemChat
    // packets with a {"player":{"name":"..."}} selector embedded in the
    // message NBT. Extract the player name and UUID so callers can
    // distinguish player chat from true system messages.
    let sender = null
    let effectivePosition = position
    if (position === 'system' && msg && msg.json) {
      const playerName = extractPlayerName(msg.json)
      if (playerName) {
        sender = lookupUuidByUsername(playerName)
        // Even if we can't resolve the UUID, treat this as player chat
        // so that bot.on('chat') patterns and whisper detection work.
        effectivePosition = 'chat'
        // Attach the player name to the message object for callers that
        // need the username but only have the UUID (or null).
        if (!msg.senderName) msg.senderName = playerName
      }
    }

    bot.emit('message', msg, effectivePosition, sender)
    bot.emit('messagestr', msg.toString(), effectivePosition, msg, sender)
    if (data.positionId === 2) bot.emit('actionBar', msg, sender)
  })

  function chatWithHeader (header, message) {
    if (typeof message === 'number') message = message.toString()
    if (typeof message !== 'string') {
      throw new Error('Chat message type must be a string or number: ' + typeof message)
    }

    if (!header && message.startsWith('/')) {
      // Do not try and split a command without a header
      bot._client.chat(message)
      return
    }

    const lengthLimit = CHAT_LENGTH_LIMIT - header.length
    message.split('\n').forEach((subMessage) => {
      if (!subMessage) return
      let i
      let smallMsg
      for (i = 0; i < subMessage.length; i += lengthLimit) {
        smallMsg = header + subMessage.substring(i, i + lengthLimit)
        bot._client.chat(smallMsg)
      }
    })
  }

  async function tabComplete (text, assumeCommand = false, sendBlockInSight = true, timeout = 5000) {
    let position

    if (sendBlockInSight) {
      const block = bot.blockAtCursor()

      if (block) {
        position = block.position
      }
    }

    bot._client.write('tab_complete', {
      text,
      assumeCommand,
      lookedAtBlock: position
    })

    const [packet] = await onceWithCleanup(bot._client, 'tab_complete', { timeout })
    return packet.matches
  }

  bot.whisper = (username, message) => {
    chatWithHeader(`/tell ${username} `, message)
  }
  bot.chat = (message) => {
    chatWithHeader('', message)
  }

  bot.tabComplete = tabComplete

  function addDefaultPatterns () {
    // 1.19 changes the chat format to move <sender> prefix from message contents to a separate field.
    // TODO: new chat lister to handle this
    if (!defaultChatPatterns) return
    bot.addChatPattern('whisper', new RegExp(`^${USERNAME_REGEX} whispers(?: to you)?:? (.*)$`), { deprecated: true })
    bot.addChatPattern('whisper', new RegExp(`^\\[${USERNAME_REGEX} -> \\w+\\s?\\] (.*)$`), { deprecated: true })
    bot.addChatPattern('chat', LEGACY_VANILLA_CHAT_REGEX, { deprecated: true })
  }

  function awaitMessage (...args) {
    const timeout = typeof args[args.length - 1] === 'number' ? args.pop() : 20000
    return new Promise((resolve, reject) => {
      const resolveMessages = args.flatMap(x => x)
      const timeoutHandle = setTimeout(() => {
        bot.off('messagestr', messageListener)
        reject(new Error(`Timeout waiting for message after ${timeout}ms`))
      }, timeout)

      function messageListener (msg) {
        if (resolveMessages.some(x => x instanceof RegExp ? x.test(msg) : msg === x)) {
          clearTimeout(timeoutHandle)
          resolve(msg)
          bot.off('messagestr', messageListener)
        }
      }
      bot.on('messagestr', messageListener)
    })
  }
  bot.awaitMessage = awaitMessage
}
