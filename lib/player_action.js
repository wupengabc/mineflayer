function playerAction (bot, action) {
  // 26.3 inserts CHANGE_DESTROY_DIRECTION after START_DESTROY_BLOCK.
  return action > 0 && bot.protocolVersion >= 777 ? action + 1 : action
}

module.exports = { playerAction }
