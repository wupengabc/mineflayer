module.exports = inject

function inject (bot) {
  const ScoreBoard = require('../scoreboard')(bot)
  const scoreboards = {}
  const pendingPositions = new Map()

  function listen (names, handler) {
    for (const name of names) bot._client.on(name, handler)
  }

  function objectiveName (packet) {
    return packet.name ?? packet.objectiveName
  }

  function objectiveAction (packet) {
    const action = packet.action ?? packet.method
    if (action === 'add' || action === 'create') return 0
    if (action === 'remove') return 1
    if (action === 'change' || action === 'update') return 2
    return action
  }

  function setPosition (position, name) {
    const previous = ScoreBoard.positions[position]
    if (!name) {
      pendingPositions.delete(position)
      delete ScoreBoard.positions[position]
      bot.emit('scoreboardPosition', position, undefined, previous)
      return
    }

    const scoreboard = scoreboards[name]
    if (scoreboard === undefined) {
      pendingPositions.set(position, name)
      return
    }

    pendingPositions.delete(position)
    bot.emit('scoreboardPosition', position, scoreboard, previous)
    ScoreBoard.positions[position] = scoreboard
  }

  function objectiveHandler (packet) {
    const name = objectiveName(packet)
    const action = objectiveAction(packet)
    const displayText = packet.displayText ?? packet.displayName ?? packet.display

    if (action === 0) {
      const scoreboard = new ScoreBoard(packet)
      if (displayText !== undefined) scoreboard.setTitle(displayText)
      scoreboards[name] = scoreboard

      bot.emit('scoreboardCreated', scoreboard)

      for (const [position, pendingName] of pendingPositions) {
        if (pendingName === name) setPosition(position, name)
      }
    }

    if (action === 1) {
      const scoreboard = scoreboards[name]
      bot.emit('scoreboardDeleted', scoreboard)
      delete scoreboards[name]

      for (const position in ScoreBoard.positions) {
        if (!ScoreBoard.positions[position]) continue
        const scoreboard = ScoreBoard.positions[position]

        if (scoreboard && scoreboard.name === name) {
          delete ScoreBoard.positions[position]
        }
      }
      for (const [position, pendingName] of pendingPositions) {
        if (pendingName === name) pendingPositions.delete(position)
      }
    }

    if (action === 2) {
      if (!Object.hasOwn(scoreboards, name)) {
        bot.emit('error', new Error(`Received update for unknown objective ${name}`))
        return
      }
      scoreboards[name].setTitle(displayText)
      bot.emit('scoreboardTitleChanged', scoreboards[name])
    }
  }

  listen(['scoreboard_objective', 'set_objective'], objectiveHandler)

  function scoreHandler (packet) {
    const itemName = packet.itemName ?? packet.owner
    const scoreName = packet.scoreName ?? packet.objectiveName
    const value = packet.value ?? packet.score
    const scoreboard = scoreboards[scoreName]
    if (packet.action !== undefined) {
      // Pre-1.20.3 format: has action field (0=create/update, 1=remove)
      if (scoreboard !== undefined && packet.action === 0) {
        const updated = scoreboard.add(itemName, value)
        bot.emit('scoreUpdated', scoreboard, updated)
      }

      if (packet.action === 1) {
        if (scoreboard !== undefined) {
          const removed = scoreboard.remove(itemName)
          return bot.emit('scoreRemoved', scoreboard, removed)
        }

        for (const sb of Object.values(scoreboards)) {
          if (itemName in sb.itemsMap) {
            const removed = sb.remove(itemName)
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
        const updated = scoreboard.add(itemName, value, {
          displayName: packet.display_name ?? packet.display ?? packet.displayName,
          numberFormat: packet.number_format ?? packet.numberFormat,
          styling: packet.styling
        })
        bot.emit('scoreUpdated', scoreboard, updated)
      }
    }
  }

  listen(['scoreboard_score', 'set_score'], scoreHandler)

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

  function displayHandler (packet) {
    setPosition(packet.position ?? packet.slot, packet.name ?? packet.objectiveName)
  }

  listen(['scoreboard_display_objective', 'set_display_objective'], displayHandler)

  bot.scoreboards = scoreboards
  bot.scoreboard = ScoreBoard.positions
}
