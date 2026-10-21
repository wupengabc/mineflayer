const nbt = require('prismarine-nbt')
module.exports = inject

const difficultyNames = ['peaceful', 'easy', 'normal', 'hard']
const gameModes = ['survival', 'creative', 'adventure', 'spectator']

const dimensionNames = {
  '-1': 'the_nether',
  0: 'overworld',
  1: 'the_end'
}

const parseGameMode = gameModeBits => {
  if (gameModeBits < 0 || gameModeBits > 0b11) {
    return 'survival'
  }
  return gameModes[(gameModeBits & 0b11)] // lower two bits
}

function inject (bot, options) {
  function getBrandCustomChannelName () {
    if (bot.supportFeature('customChannelMCPrefixed')) {
      return 'MC|Brand'
    } else if (bot.supportFeature('customChannelIdentifier')) {
      return 'minecraft:brand'
    }
    throw new Error('Unsupported brand channel name')
  }

  function handleRespawnPacketData (packet) {
    bot.game.levelType = packet.levelType ?? (packet.isFlat ? 'flat' : 'default')
    bot.game.hardcore = packet.isHardcore ?? Boolean(packet.gameMode & 0b100)
    // Either a respawn packet or a login packet. Depending on the packet it can be "gamemode" or "gameMode"
    if (bot.supportFeature('spawnRespawnWorldDataField')) { // 1.20.5
      bot.game.gameMode = packet.gamemode
    } else {
      bot.game.gameMode = parseGameMode(packet.gamemode ?? packet.gameMode)
    }
    if (bot.supportFeature('segmentedRegistryCodecData')) { // 1.20.5
      if (typeof packet.dimension === 'number') {
        bot.game.dimension = bot.registry.dimensionsArray[packet.dimension]?.name?.replace('minecraft:', '')
      } else if (typeof packet.dimension === 'string') { // iirc, in 1.21 it's back to a string
        bot.game.dimension = packet.dimension.replace('minecraft:', '')
      }
    } else if (bot.supportFeature('dimensionIsAnInt')) {
      bot.game.dimension = dimensionNames[packet.dimension]
    } else if (bot.supportFeature('dimensionIsAString')) {
      bot.game.dimension = packet.dimension.replace('minecraft:', '')
    } else if (bot.supportFeature('dimensionIsAWorld')) {
      if (bot.supportFeature('dimensionDataInCodec')) {
        // For 1.19+, we need the dimension TYPE name (not the world/level name) so
        // the codec lookup succeeds. In login packets the type is "worldType"; in
        // respawn packets it is "dimension". worldName is the level name which may
        // differ from the type on proxy/modded servers.
        const dimType = packet.worldType ?? packet.dimension
        bot.game.dimension = typeof dimType === 'string'
          ? dimType.replace('minecraft:', '')
          : packet.worldName.replace('minecraft:', '')
      } else {
        bot.game.dimension = packet.worldName.replace('minecraft:', '')
      }
    } else {
      throw new Error('Unsupported dimension type in login packet')
    }

    if (packet.dimensionCodec) {
      bot.registry.loadDimensionCodec(packet.dimensionCodec)
    }

    bot.game.minY = 0
    bot.game.height = 256

    if (bot.supportFeature('dimensionDataInCodec')) { // 1.19+
      const dimData = bot.registry.dimensionsByName[bot.game.dimension]
      if (dimData) {
        bot.game.minY = dimData.minY
        bot.game.height = dimData.height
      }
    } else if (bot.supportFeature('dimensionDataIsAvailable')) { // 1.16.2+
      const dimensionData = nbt.simplify(packet.dimension)
      bot.game.minY = dimensionData.min_y
      bot.game.height = dimensionData.height
    }

    if (packet.difficulty !== undefined && packet.difficulty !== null) {
      bot.game.difficulty = typeof packet.difficulty === 'string'
        ? packet.difficulty
        : difficultyNames[packet.difficulty]
    }
  }

  bot.game = {}

  const brandChannel = getBrandCustomChannelName()
  bot._client.registerChannel(brandChannel, ['string', []])

  let registryEntries = new Map()
  let registryTags = new Map()
  let enabledFeatures
  bot.registry.registries = Object.create(null)
  bot.registry.tags = Object.create(null)

  bot._client.on('state', (state) => {
    if (state !== 'configuration') return
    registryEntries = new Map()
    registryTags = new Map()
    enabledFeatures = undefined
  })

  // 1.20.2
  bot._client.on('registry_data', (packet) => {
    if (!bot.supportFeature('segmentedRegistryCodecData')) {
      bot.registry.loadDimensionCodec(packet.codec || packet)
      return
    }
    // RegistryDataCollector.ContentsCollector appends, including packets for
    // the same registry. IDs are the positions in the complete entry list.
    const entries = registryEntries.get(packet.id) || []
    entries.push(...packet.entries)
    registryEntries.set(packet.id, entries)
  })

  bot._client.on('tags', (packet) => {
    if (!Array.isArray(packet.tags)) return // older protocols group tags by kind instead
    for (const registry of packet.tags) {
      if (bot._client.state === 'configuration') registryTags.set(registry.tagType, registry.tags)
      else bot.registry.tags[registry.tagType] = registry.tags
    }
  })

  bot._client.on('feature_flags', (packet) => {
    enabledFeatures = packet.features
  })

  // Run before the protocol plugin acknowledges completion and enters play.
  bot._client.prependListener('finish_configuration', () => {
    if (registryEntries.size > 0) {
      bot.registry.registries = Object.create(null)
      bot.registry.tags = Object.create(null)
      for (const [id, entries] of registryEntries) {
        bot.registry.registries[id] = { id, entries }
      }
      for (const id of ['minecraft:dimension_type', 'minecraft:worldgen/biome', 'minecraft:chat_type']) {
        const entries = registryEntries.get(id) || []
        // No known packs are advertised, so omitted values cannot be resolved
        // from local resources. Retain them raw without fabricating defaults or
        // compacting IDs; the helper cannot represent a partially known registry.
        bot.registry.loadDimensionCodec({ id, entries: entries.every(entry => entry.value != null) ? entries : [] })
      }
    }
    for (const [id, tags] of registryTags) bot.registry.tags[id] = tags
    if (enabledFeatures !== undefined) bot.game.enabledFeatures = enabledFeatures
    registryEntries = new Map()
    registryTags = new Map()
    enabledFeatures = undefined
  })

  bot._client.on('login', (packet) => {
    handleRespawnPacketData(packet.worldState || packet)

    bot.game.maxPlayers = packet.maxPlayers
    if (packet.enableRespawnScreen) {
      bot.game.enableRespawnScreen = packet.enableRespawnScreen
    }
    if (packet.viewDistance) {
      bot.game.serverViewDistance = packet.viewDistance
    }

    bot.emit('login')
    // Emitted only for the very first Login (play) packet of this connection.
    // Proxy server switches (BungeeCord/Velocity) re-send a Login packet on the
    // same connection, which re-triggers 'login'; 'initialLogin' fires once.
    if (!bot._hasEmittedInitialLogin) {
      bot._hasEmittedInitialLogin = true
      bot.emit('initialLogin')
    }
    bot.emit('game')

    // varint length-prefixed string as data
    if (!bot.supportFeature('hasConfigurationState')) bot._client.writeChannel(brandChannel, options.brand)
  })

  bot._client.on('respawn', (packet) => {
    // in 1.20.5+ protocol we move the shared spawn data into one SpawnInfo type under .worldState
    handleRespawnPacketData(packet.worldState || packet)
    bot.emit('game')
  })

  bot._client.on('game_state_change', (packet) => {
    if ((packet.reason === 4 || packet.reason === 'win_game') && packet.gameMode === 1) {
      bot._client.write('client_command', { action: 0 })
    }
    if ((packet.reason === 3) || (packet.reason === 'change_game_mode')) {
      bot.game.gameMode = parseGameMode(packet.gameMode)
      bot.emit('game')
    }
  })

  bot._client.on('difficulty', (packet) => {
    bot.game.difficulty = typeof packet.difficulty === 'string'
      ? packet.difficulty
      : difficultyNames[packet.difficulty]
  })

  bot._client.on(brandChannel, (serverBrand) => {
    bot.game.serverBrand = serverBrand
  })

  // 26.1+ game rule values broadcast (toClient Play 0x27).
  // The packet carries an array of { name, value } entries; we dictionarize
  // them into bot.game.gameRules (last write wins on duplicate names) and
  // emit a single 'gameRulesUpdated' event with the resulting dictionary.
  bot._client.on('game_rule_values', (packet) => {
    if (!bot.game.gameRules) bot.game.gameRules = {}
    const rules = Array.isArray(packet?.rules) ? packet.rules : []
    for (const rule of rules) {
      if (rule == null) continue
      bot.game.gameRules[rule.name] = rule.value
    }
    bot.emit('gameRulesUpdated', bot.game.gameRules)
  })

  // mimic the vanilla 1.17 client to prevent anticheat kicks
  bot._client.on('ping', (data) => {
    if (bot._client.state === 'configuration') return // handled there by minecraft-protocol
    bot._client.write('pong', {
      id: data.id
    })
  })
}
