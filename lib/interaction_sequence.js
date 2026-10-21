const predictions = new WeakMap()

function getNextSequence (bot) {
  // Prediction sequences were added in 1.19. Older codecs ignore this field.
  if (!(bot.protocolVersion >= 759)) return 0

  let prediction = predictions.get(bot)
  if (!prediction) {
    prediction = { sequence: 0, world: bot.world, level: bot._getDimensionName?.() }
    predictions.set(bot, prediction)

    const reset = () => { prediction.sequence = 0 }
    const levelName = packet => packet.worldState?.name ?? packet.worldName
    // Run before plugins emit public login/respawn events and allow actions.
    bot._client.prependListener('login', packet => {
      reset()
      prediction.level = levelName(packet)
    })
    bot._client.prependListener('respawn', packet => {
      const level = levelName(packet)
      // Vanilla keeps ClientLevel (and its predictor) on same-world respawn.
      if (level !== prediction.level) reset()
      prediction.level = level
    })
    bot._client.prependListener('start_configuration', reset)
  }

  if (prediction.world !== bot.world) {
    prediction.sequence = 0
    prediction.world = bot.world
  }
  return ++prediction.sequence
}

module.exports = { getNextSequence }
