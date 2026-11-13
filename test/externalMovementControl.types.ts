import type { Bot } from '..'

declare const bot: Bot
const result: void = bot.setExternalMovementControl(true)
bot.setExternalMovementControl(false)
void result
// @ts-expect-error Movement control requires an explicit boolean.
bot.setExternalMovementControl()
// @ts-expect-error Truthy strings are not accepted.
bot.setExternalMovementControl('true')
