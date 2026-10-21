module.exports = inject

function inject (bot) {
  let latestPack
  const activeResourcePacks = new Map()
  const TEXTURE_PACK_RESULTS = {
    SUCCESSFULLY_LOADED: 0,
    DECLINED: 1,
    FAILED_DOWNLOAD: 2,
    ACCEPTED: 3
  }

  bot._client.on('add_resource_pack', (data) => { // Emits the same as resource_pack_send but sends uuid rather than hash because that's how active packs are tracked
    // Keep the wire UUID string, and install the request before invoking callbacks.
    latestPack = { uuid: data.uuid }
    activeResourcePacks.set(data.uuid, latestPack)
    bot.emit('resourcePack', data.url, data.uuid)
  })

  bot._client.on('remove_resource_pack', (data) => { // Doesn't emit  anything because it is removing rather than adding
    // if uuid isn't provided remove all packs
    if (data.uuid == null) {
      activeResourcePacks.clear()
      latestPack = undefined
    } else {
      activeResourcePacks.delete(data.uuid)
      if (latestPack?.uuid === data.uuid) latestPack = undefined
    }
  })

  bot._client.on('resource_pack_send', (data) => {
    latestPack = { uuid: data.uuid, hash: data.hash }
    if (bot.supportFeature('resourcePackUsesUUID')) {
      activeResourcePacks.set(data.uuid, latestPack)
      bot.emit('resourcePack', data.url, data.uuid)
    } else {
      bot.emit('resourcePack', data.url, data.hash)
    }
  })

  function respond (result, pack) {
    const response = { result }
    if (bot.supportFeature('resourcePackUsesUUID')) response.uuid = pack.uuid
    else if (bot.supportFeature('resourcePackUsesHash')) response.hash = pack.hash
    bot._client.write('resource_pack_receive', response)
  }

  function acceptResourcePack () {
    const pack = latestPack
    if (!pack || pack.responded) return
    pack.responded = true
    // The public API historically asserts both acceptance and completion. Only
    // an explicit caller may make that assertion; receiving a pack never does.
    respond(TEXTURE_PACK_RESULTS.ACCEPTED, pack)
    respond(TEXTURE_PACK_RESULTS.SUCCESSFULLY_LOADED, pack)
  }

  function denyResourcePack () {
    const pack = latestPack
    if (!pack || pack.responded) return
    pack.responded = true
    respond(TEXTURE_PACK_RESULTS.DECLINED, pack)
  }

  bot.acceptResourcePack = acceptResourcePack
  bot.denyResourcePack = denyResourcePack
}
