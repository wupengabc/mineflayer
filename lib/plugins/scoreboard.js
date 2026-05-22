module.exports = inject

function inject (bot) {
  const ScoreBoard = require('../scoreboard')(bot)
  const scoreboards = {}

  bot._client.on('scoreboard_objective', (packet) => {
    if (packet.action === 0) {
      const { name } = packet
      const scoreboard = new ScoreBoard(packet)
      scoreboards[name] = scoreboard

      bot.emit('scoreboardCreated', scoreboard)
    }

    if (packet.action === 1) {
      bot.emit('scoreboardDeleted', scoreboards[packet.name])
      delete scoreboards[packet.name]

      for (const position in ScoreBoard.positions) {
        if (!ScoreBoard.positions[position]) continue
        const scoreboard = ScoreBoard.positions[position]

        if (scoreboard && scoreboard.name === packet.name) {
          delete ScoreBoard.positions[position]
          break
        }
      }
    }

    if (packet.action === 2) {
      if (!Object.hasOwn(scoreboards, packet.name)) {
        bot.emit('error', new Error(`Received update for unknown objective ${packet.name}`))
        return
      }
      scoreboards[packet.name].setTitle(packet.displayText)
      bot.emit('scoreboardTitleChanged', scoreboards[packet.name])
    }
  })

  bot._client.on('scoreboard_score', (packet) => {
    const scoreboard = scoreboards[packet.scoreName]
    if (packet.action !== undefined) {
      // Pre-1.20.3 format: has action field (0=create/update, 1=remove)
      if (scoreboard !== undefined && packet.action === 0) {
        const updated = scoreboard.add(packet.itemName, packet.value)
        bot.emit('scoreUpdated', scoreboard, updated)
      }

      if (packet.action === 1) {
        if (scoreboard !== undefined) {
          const removed = scoreboard.remove(packet.itemName)
          return bot.emit('scoreRemoved', scoreboard, removed)
        }

        for (const sb of Object.values(scoreboards)) {
          if (packet.itemName in sb.itemsMap) {
            const removed = sb.remove(packet.itemName)
            return bot.emit('scoreRemoved', sb, removed)
          }
        }
      }
    } else {
      // 1.20.3+ format: no action field, always an update/set
      if (scoreboard !== undefined) {
        // 26.1 (and 1.20.3+) carry an optional `display_name` chat component
        // and an optional `number_format` + `styling`. Pass them along so the
        // ScoreBoard item can render the actual visible text instead of the
        // bookkeeping placeholder owner.
        const updated = scoreboard.add(packet.itemName, packet.value, {
          displayName: packet.display_name ?? packet.displayName,
          numberFormat: packet.number_format ?? packet.numberFormat,
          styling: packet.styling
        })
        bot.emit('scoreUpdated', scoreboard, updated)
      }
    }
  })

  // 1.20.3+ uses a separate packet for score removal
  bot._client.on('reset_score', (packet) => {
    const entityName = packet.entity_name || packet.entityName
    const objectiveName = packet.objective_name || packet.objectiveName
    if (objectiveName) {
      const scoreboard = scoreboards[objectiveName]
      if (scoreboard !== undefined) {
        const removed = scoreboard.remove(entityName)
        return bot.emit('scoreRemoved', scoreboard, removed)
      }
    } else {
      // No objective specified — remove from all scoreboards
      for (const sb of Object.values(scoreboards)) {
        if (entityName in sb.itemsMap) {
          const removed = sb.remove(entityName)
          bot.emit('scoreRemoved', sb, removed)
        }
      }
    }
  })

  bot._client.on('scoreboard_display_objective', (packet) => {
    const { name, position } = packet
    const scoreboard = scoreboards[name]

    if (scoreboard !== undefined) {
      bot.emit('scoreboardPosition', position, scoreboard, ScoreBoard.positions[position])
      ScoreBoard.positions[position] = scoreboard
    }
  })

  bot.scoreboards = scoreboards
  bot.scoreboard = ScoreBoard.positions
}
