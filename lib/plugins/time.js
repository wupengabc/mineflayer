module.exports = inject

function inject (bot) {
  bot.time = {
    doDaylightCycle: null,
    bigTime: null,
    time: null,
    timeOfDay: null,
    day: null,
    isDay: null,
    moonPhase: null,
    bigAge: null,
    age: null
  }
  bot._client.on('update_time', (packet) => {
    // 26.1+ uses gameTime + clockUpdates instead of age/time/tickDayTime
    let time, age, doDaylightCycle
    if (packet.gameTime !== undefined) {
      // 26.1+ format
      age = longToBigInt(packet.gameTime)
      // Find the day time clock from clockUpdates (clockId 0 is typically the day clock)
      const dayClock = packet.clockUpdates && packet.clockUpdates.length > 0
        ? packet.clockUpdates[0]
        : null
      if (dayClock) {
        time = BigInt(dayClock.totalTicks)
        doDaylightCycle = dayClock.rate > 0
      } else {
        time = age
        doDaylightCycle = true
      }
    } else {
      // Pre-26.1 format
      time = longToBigInt(packet.time)
      age = longToBigInt(packet.age)
      doDaylightCycle = packet.tickDayTime !== undefined ? !!packet.tickDayTime : time >= 0n
    }
    // When doDaylightCycle is false, we need to take the absolute value of time
    const finalTime = doDaylightCycle ? time : (time < 0n ? -time : time)

    bot.time.doDaylightCycle = doDaylightCycle
    bot.time.bigTime = finalTime
    bot.time.time = Number(finalTime)
    bot.time.timeOfDay = bot.time.time % 24000
    bot.time.day = Math.floor(bot.time.time / 24000)
    bot.time.isDay = bot.time.timeOfDay >= 0 && bot.time.timeOfDay < 13000
    bot.time.moonPhase = bot.time.day % 8
    bot.time.bigAge = age
    bot.time.age = Number(age)

    bot.emit('time')
  })
}

function longToBigInt (arr) {
  return BigInt.asIntN(64, (BigInt(arr[0]) << 32n)) | BigInt(arr[1])
}
