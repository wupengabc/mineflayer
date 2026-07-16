'use strict'

const { Vec3 } = require('vec3')

module.exports = inject
// Expose tagWith261 as a module-level property for unit/property tests
// (Property 10 in the design doc) without coupling on internal NMP paths.
module.exports.tagWith261 = tagWith261

// Local copy of node-minecraft-protocol/src/utils/tagWith261 to avoid coupling
// on internal NMP paths. Tags 26.1 protocol-stage errors with protocolVersion=775
// before they are emitted/thrown so consumers can filter on protocol version.
function tagWith261 (err) {
  if (err && typeof err === 'object') {
    err.protocolVersion = 775
  }
  return err
}

// 26.1-specific lightweight packet routing plugin.
//
// Activated only when the negotiated protocol version is 775 (Minecraft 26.1.x);
// short-circuits otherwise so older versions keep their legacy paths untouched.
//
// Responsibilities:
//   * Task 9.3 — handle `low_disk_space_warning` (warn-level log, no disconnect).
//   * Task 9.4 — forward NMP `'rawPacket'` events (only those tagged 26.1) as
//                mineflayer's `'packetUnimplemented'` event with a synthetic name.
//   * Task 9.5 — install a pre-hook on the toClient Play 0x48 (`position`,
//                aka `player_position`) packet that emits `'serverPositionCorrection'`
//                BEFORE the existing physics.js correction logic mutates bot.entity.
//
// Validates: Requirements 11.5, 11.6, 15.1, 15.3, 15.5
function inject (bot) {
  // Feature gate: only active on 26.1.x (protocol 775). bot.protocolVersion is
  // populated in lib/loader.js's `next()` before `inject_allowed` is emitted,
  // so this check is safe at inject time.
  if (bot.protocolVersion !== 775) return

  // ---------------------------------------------------------------------------
  // Task 9.3: low_disk_space_warning
  //
  // Server signals it is low on disk space. Mineflayer should surface this at
  // warn level but MUST NOT disconnect — the connection stays open.
  // ---------------------------------------------------------------------------
  bot._client.on('low_disk_space_warning', () => {
    if (typeof bot._warn === 'function') {
      bot._warn('low_disk_space_warning: server reports low disk space (protocolVersion=775)')
    } else {
      console.warn('[mineflayer] low_disk_space_warning: server reports low disk space (protocolVersion=775)')
    }
  })

  // ---------------------------------------------------------------------------
  // Task 9.4: rawPacket -> packetUnimplemented bridge
  //
  // NMP emits `'rawPacket'` on the client when an inbound VarInt packet id is
  // not registered in the active state's packet table (see Requirement 15.1).
  // We translate that into mineflayer's `'packetUnimplemented'` event, but only
  // when the rawPacket originated from the 26.1 protocol path.
  //
  // The event payload follows the spec exactly:
  //   { packetId, state, protocolVersion: 775,
  //     name: 'unimplemented_<state>_0x<id>' }   // <id> is lowercase hex
  // ---------------------------------------------------------------------------
  bot._client.on('rawPacket', (raw) => {
    if (!raw || raw.protocolVersion !== 775) return
    const { state, packetId, malformed = false } = raw
    const idHex = `0x${Number(packetId).toString(16)}`
    bot.emit('packetUnimplemented', {
      packetId,
      state,
      protocolVersion: 775,
      name: `unimplemented_${state}_${idHex}`,
      malformed
    })
  })

  // ---------------------------------------------------------------------------
  // Task 9.5: toClient Play 0x48 (`position`) pre-hook
  //
  // The existing physics.js plugin already listens to `'position'` and runs
  // mineflayer's correction logic. We need to fire BEFORE that handler so we
  // can capture `oldPos` while bot.entity still reflects the pre-correction
  // state. EventEmitter#prependListener guarantees registration order doesn't
  // matter — our listener will always run first.
  //
  // After computing the new server-supplied position (applying the same flag
  // semantics physics.js uses, i.e. relative vs absolute per axis), we emit
  // `'serverPositionCorrection'` with { from, to, distance, protocolVersion }.
  // ---------------------------------------------------------------------------
  bot._client.prependListener('position', (packet) => {
    try {
      if (!bot.entity || !bot.entity.position) return

      // Snapshot pre-correction position. Vec3#clone() so subsequent mutation
      // by the existing correction logic doesn't aliased-mutate `from`.
      const oldPos = bot.entity.position.clone()

      // Apply the same flag semantics as physics.js's existing handler:
      //   1.20.5+      -> packet.flags is an object with named axis bits
      //   pre-1.20.5   -> packet.flags is a bitmask number (1=x, 2=y, 4=z)
      // A set flag means the corresponding coordinate is RELATIVE to oldPos;
      // an unset flag means the coordinate is ABSOLUTE.
      let nx, ny, nz
      if (typeof packet.flags === 'object' && packet.flags !== null) {
        nx = packet.flags.x ? oldPos.x + packet.x : packet.x
        ny = packet.flags.y ? oldPos.y + packet.y : packet.y
        nz = packet.flags.z ? oldPos.z + packet.z : packet.z
      } else {
        nx = (packet.flags & 1) ? oldPos.x + packet.x : packet.x
        ny = (packet.flags & 2) ? oldPos.y + packet.y : packet.y
        nz = (packet.flags & 4) ? oldPos.z + packet.z : packet.z
      }
      const newPos = new Vec3(nx, ny, nz)
      const distance = oldPos.distanceTo(newPos)

      bot.emit('serverPositionCorrection', {
        from: oldPos,
        to: newPos,
        distance,
        protocolVersion: 775
      })
    } catch (err) {
      // Don't let a diagnostic event break the packet pipeline. Tag the error
      // so consumers can identify it as originating from the 26.1 stack, then
      // surface it via the bot's standard error channel.
      bot.emit('error', tagWith261(err))
    }
  })

  // ---------------------------------------------------------------------------
  // Task 11.3: player_loaded (toServer 0x2C)
  //
  // 26.1 servers expect a serverbound `player_loaded` packet exactly once per
  // chunk-load completion. mineflayer's `chunkColumnLoad` event is emitted by
  // lib/plugins/blocks.js for each chunk column finishing load (forwarded
  // from bot.world). Subscribe with `on` (not `once`) so every chunk emits a
  // fresh ack — Requirement 13.6 says "每次区块加载完成事件恰一次".
  //
  // Gated on bot.supportFeature('playerLoaded') so the feature flag in
  // minecraft-data is the single source of truth for which versions opt in.
  //
  // Validates: Requirements 13.6
  // ---------------------------------------------------------------------------
  if (bot.supportFeature('playerLoaded')) {
    bot.on('chunkColumnLoad', () => {
      try {
        bot._client.write('player_loaded', {})
      } catch (err) {
        bot.emit('error', tagWith261(err))
      }
    })
  }
}
