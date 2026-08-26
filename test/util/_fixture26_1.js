'use strict'

// Test fixture infrastructure for the mineflayer-26-1-physics-and-action-bugs spec.
//
// Exports:
//   - startFixtureServer({ protocolVersion: 775, world })
//       Spins up an NMP createServer({ version: '26.1.2' }) listener on a random
//       loopback port. On the first playerJoin it writes a 26.1.2 login packet
//       and (if `world` is provided) a single map_chunk packet containing the
//       blocks the test asked for. Returns { server, port, host, world }.
//
//   - connectBot({ host, port, version: '26.1.2' })
//       Calls mineflayer.createBot() with the offline-mode fixture defaults
//       used across the 26.1 tests (auth: 'offline', random username, modest
//       checkTimeoutInterval). Returns the bot.
//
// The shape mirrors the fixture style already in use in
// mineflayer/test/internalTest.js (mc.createServer + bot.test.generateLoginPacket
// + chunk built via prismarine-chunk + map_chunk write) so spec tasks 2..5 can
// drive their exploratory PBTs without re-deriving the boilerplate.
//
// Pre-placed-block support: callers pass a `world` argument shaped as
//   {
//     chunkX?: number,        // default 0
//     chunkZ?: number,        // default 0
//     minY?: number,          // default registry.supportFeature('tallWorld') ? -64 : 0
//     worldHeight?: number,   // default tallWorld ? 384 : 256
//     blocks: [
//       { pos: Vec3 | { x, y, z }, name: string, stateOffset?: number },
//       ...
//     ],
//     fillFloor?: { y: number, name: string }   // optional: paint a 16x16 layer
//   }
// All `name` strings must resolve through the 26.1.2 minecraft-data block
// registry; callers can request slabs / stairs / snow / carpets / fences /
// trapdoors / farmland / stone / etc. — the registry-resolution layer reports
// the canonical 26.1.2 minStateId so block-shape-sensitive tests get the same
// state ids the real server would emit.
//
// Validates: Requirements 1.1, 1.3, 1.5, 1.7 (fixture infrastructure for the
// four 26.1 bug-condition exploratory tests).

const mc = require('minecraft-protocol')
const mineflayer = require('../..')
const { Vec3 } = require('vec3')
const { SmartBuffer } = require('smart-buffer')
const { getPort } = require('../common/util')
const { once } = require('../../lib/promise_utils')

const FIXTURE_VERSION = '26.1.2'
const FIXTURE_PROTOCOL = 775

// ---------------------------------------------------------------------------
// startFixtureServer
// ---------------------------------------------------------------------------
async function startFixtureServer ({ protocolVersion = FIXTURE_PROTOCOL, world = null } = {}) {
  if (protocolVersion !== FIXTURE_PROTOCOL) {
    throw new Error(
      `_fixture26_1.startFixtureServer: protocolVersion must be ${FIXTURE_PROTOCOL} (26.1.2), got ${protocolVersion}`
    )
  }

  const registry = require('prismarine-registry')(FIXTURE_VERSION)
  const Chunk = require('prismarine-chunk')(FIXTURE_VERSION)

  const port = await getPort()
  const server = mc.createServer({
    'online-mode': false,
    version: FIXTURE_VERSION,
    port,
    host: '127.0.0.1',
    motd: 'mineflayer 26.1 fixture',
    maxPlayers: 1,
    hideErrors: false
  })

  await once(server, 'listening')

  // Build the chunk eagerly so any block-name typos surface before the bot
  // connects. Returns the prismarine-chunk Chunk instance, or null when the
  // caller did not request a pre-populated world.
  const chunk = world ? buildChunkFromWorld(world, { Chunk, registry }) : null
  const chunkCoords = world
    ? { x: world.chunkX ?? 0, z: world.chunkZ ?? 0 }
    : { x: 0, z: 0 }

  // The login packet for 26.1.2 is enormous (full registry codec). Pull the
  // canonical one from prismarine-registry — that's what NMP itself ships and
  // what the real server sends. Override only the fields the fixture needs.
  function generateLoginPacket () {
    const loginPacket = registry.loginPacket
    if (!loginPacket) {
      throw new Error("_fixture26_1: prismarine-registry('26.1.2').loginPacket is missing")
    }
    return {
      ...loginPacket,
      entityId: 0,
      worldName: 'minecraft:overworld',
      worldNames: ['minecraft:overworld'],
      hashedSeed: [0, 0]
    }
  }

  function generateChunkPacket (chunkColumn, x, z) {
    const lights = chunkColumn.dumpLight ? chunkColumn.dumpLight() : {}
    return {
      x,
      z,
      groundUp: true,
      biomes: chunkColumn.dumpBiomes !== undefined ? chunkColumn.dumpBiomes() : undefined,
      heightmaps: {
        type: 'compound',
        name: '',
        value: {
          MOTION_BLOCKING: { type: 'longArray', value: new Array(36).fill([0, 0]) }
        }
      },
      bitMap: chunkColumn.getMask ? chunkColumn.getMask() : undefined,
      // 26.1+ adds a fluidCount short after each section's solidBlockCount.
      // prismarine-chunk's reader consumes it but its writer does NOT emit it,
      // so when we dump a chunk for the wire we have to splice the missing
      // shorts in ourselves. See decompiled/server/.../LevelChunkSection
      // STREAM_CODEC for the canonical 26.1 layout.
      chunkData: encodeChunkDataFor261(chunkColumn),
      blockEntities: [],
      trustEdges: false,
      skyLightMask: lights.skyLightMask,
      blockLightMask: lights.blockLightMask,
      emptySkyLightMask: lights.emptySkyLightMask,
      emptyBlockLightMask: lights.emptyBlockLightMask,
      skyLight: lights.skyLight,
      blockLight: lights.blockLight
    }
  }

  // Default playerJoin handler: deliver login + (optional) chunk + an absolute
  // position teleport so the bot.entity is ready by the time tests start
  // driving controls. Tests can attach their own `playerJoin` listener for
  // additional packet writes; the fixture default does not throw on extra
  // listeners.
  const spawnPos = world && world.spawn
    ? world.spawn
    : { x: 0.5, y: 64, z: 0.5 }

  server.on('playerJoin', (client) => {
    try {
      client.write('login', generateLoginPacket())
      if (chunk) {
        client.write('map_chunk', generateChunkPacket(chunk, chunkCoords.x, chunkCoords.z))
      }
      // 26.1 / 1.21.3+ uses the named-bitfield form of position.flags. We
      // send all-absolute (every bit cleared) so the bot lands exactly at
      // spawnPos.
      client.write('position', {
        x: spawnPos.x,
        y: spawnPos.y,
        z: spawnPos.z,
        dx: 0,
        dy: 0,
        dz: 0,
        yaw: 0,
        pitch: 0,
        flags: { x: false, y: false, z: false, yaw: false, pitch: false },
        teleportId: 0
      })
      // mineflayer's `spawn` event waits for the first `update_health` with
      // health > 0 (see lib/plugins/health.js). Send a healthy packet so
      // tests can `await once(bot, 'spawn')`.
      client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
    } catch (err) {
      // Surface fixture-side errors immediately rather than letting the test
      // time out waiting for spawn.
      server.emit('error', err)
    }
  })

  return {
    server,
    port,
    host: '127.0.0.1',
    protocolVersion: FIXTURE_PROTOCOL,
    version: FIXTURE_VERSION,
    chunk,
    spawnPos,
    // Helpers exposed for tests that need to stitch additional packets into
    // their own playerJoin listener.
    generateLoginPacket,
    generateChunkPacket,
    async close () {
      // NMP Server.close() does not accept a callback; it emits 'close' once
      // the underlying net.Server is fully shut down.
      await new Promise((resolve) => {
        server.once('close', resolve)
        server.close()
      })
    }
  }
}

// ---------------------------------------------------------------------------
// connectBot
// ---------------------------------------------------------------------------
function connectBot ({
  host = '127.0.0.1',
  port,
  version = FIXTURE_VERSION,
  username = null,
  ...overrides
} = {}) {
  if (port === undefined) {
    throw new Error('_fixture26_1.connectBot: port is required')
  }
  return mineflayer.createBot({
    host,
    port,
    username: username || ('fixture26_1_' + Math.floor(Math.random() * 1e6).toString(36)),
    version,
    auth: 'offline',
    checkTimeoutInterval: 60 * 1000,
    ...overrides
  })
}

// ---------------------------------------------------------------------------
// Internal: build a prismarine-chunk column from the caller's `world` recipe.
// ---------------------------------------------------------------------------
function buildChunkFromWorld (world, { Chunk, registry }) {
  const tallWorld = registry.supportFeature('tallWorld')
  const minY = world.minY !== undefined ? world.minY : (tallWorld ? -64 : 0)
  const worldHeight = world.worldHeight !== undefined ? world.worldHeight : (tallWorld ? 384 : 256)

  let chunk
  if (tallWorld) {
    chunk = new Chunk({ minY, worldHeight })
  } else {
    chunk = new Chunk()
  }

  // Optional uniform floor pass so tests don't have to enumerate 256 blocks
  // just to give the bot something to stand on.
  if (world.fillFloor) {
    const { y, name } = world.fillFloor
    const stateId = resolveBlockStateId(name, registry)
    for (let lx = 0; lx < 16; lx++) {
      for (let lz = 0; lz < 16; lz++) {
        chunk.setBlockStateId(new Vec3(lx, y, lz), stateId)
      }
    }
  }

  // Per-block placements. Each block is { pos, name, stateOffset? }; the state
  // id is resolved through the 26.1.2 registry so callers can rely on the
  // canonical minStateId without hard-coding numbers in the test.
  if (Array.isArray(world.blocks)) {
    for (const entry of world.blocks) {
      if (!entry || !entry.pos || !entry.name) {
        throw new Error('_fixture26_1: world.blocks[] entries must have { pos, name }')
      }
      const stateId = resolveBlockStateId(entry.name, registry, entry.stateOffset)
      const pos = entry.pos instanceof Vec3
        ? entry.pos
        : new Vec3(entry.pos.x, entry.pos.y, entry.pos.z)
      chunk.setBlockStateId(pos, stateId)
    }
  }

  return chunk
}

function resolveBlockStateId (name, registry, stateOffset = 0) {
  // Some legacy or alias names callers may want (e.g. snow_layer, oak_carpet)
  // do not exist verbatim in the 26.1.2 minecraft-data block table. Map them
  // to their canonical 26.1.2 names so the spec's "snow_layer / oak_carpet"
  // requirement still resolves to a valid state id.
  const ALIASES = {
    snow_layer: 'snow', // 26.1 keeps the snow_layer behaviour under blocks.json#snow
    oak_carpet: 'white_carpet' // mineflayer 26.1 carpets are colour-prefixed; pick a stable canonical
  }
  const canonical = ALIASES[name] || name
  const block = registry.blocksByName[canonical]
  if (!block) {
    throw new Error(`_fixture26_1: unknown block '${name}' (canonical: '${canonical}') in 26.1.2 registry`)
  }
  const stateId = (block.minStateId ?? block.defaultState ?? 0) + stateOffset
  if (block.maxStateId !== undefined && stateId > block.maxStateId) {
    throw new Error(
      `_fixture26_1: block '${canonical}' stateOffset=${stateOffset} exceeds maxStateId=${block.maxStateId}`
    )
  }
  return stateId
}

module.exports = {
  startFixtureServer,
  connectBot,
  // Exposed for tests that need to assemble additional chunk variants on the
  // fly without going through the full server shape.
  buildChunkFromWorld,
  resolveBlockStateId,
  encodeChunkDataFor261,
  FIXTURE_VERSION,
  FIXTURE_PROTOCOL
}

// ---------------------------------------------------------------------------
// Internal: serialize a prismarine-chunk column to the 26.1 wire format.
//
// prismarine-chunk's ChunkSection.write emits:
//     [solidBlockCount: int16BE][palette container][biome container]
// per section. The 26.1 server-side reader expects an extra fluidCount short
// between solidBlockCount and the palette container (`hasFluidCount = true`
// in PaletteChunkSection.read). We can't ask the writer to emit it because
// the installed version does not accept the flag, so we splice the missing
// shorts in by walking the dumped buffer one section at a time.
//
// Per-section layout we re-emit:
//     [solidBlockCount: int16BE]   ← copy from chunk dump
//     [fluidCount: int16BE = 0]    ← injected (no fluids in fixture chunks)
//     [palette container ...]      ← copy from chunk dump
//     [biome container ...]        ← copy from chunk dump
//
// Section boundaries are recovered by re-running ChunkSection.write /
// BiomeSection.write into a probe buffer; we copy the consumed byte ranges
// rather than re-decoding the data ourselves.
// ---------------------------------------------------------------------------
function encodeChunkDataFor261 (chunkColumn) {
  // For installations that already include fluidCount in their writer (future
  // prismarine-chunk versions), expose an opt-out via the Symbol below so we
  // don't double-emit the short.
  if (chunkColumn[Symbol.for('mineflayer-fixture26_1.fluidCountAlreadyEmitted')]) {
    return chunkColumn.dump()
  }

  const out = new SmartBuffer()
  const numSections = chunkColumn.numSections
  for (let i = 0; i < numSections; i++) {
    const section = chunkColumn.sections[i]
    const biome = chunkColumn.biomes[i]

    // Probe buffer: write section + biome to recover the produced bytes.
    const probe = new SmartBuffer()
    section.write(probe)
    const sectionBytes = probe.toBuffer()
    const biomeProbe = new SmartBuffer()
    biome.write(biomeProbe)
    const biomeBytes = biomeProbe.toBuffer()

    // Splice fluidCount=0 between solidBlockCount (first 2 bytes) and the
    // remaining palette container payload.
    const solidBlockCount = sectionBytes.readInt16BE(0)
    out.writeInt16BE(solidBlockCount)
    out.writeInt16BE(0) // fluidCount: fixture chunks have no flowing fluids
    out.writeBuffer(sectionBytes.slice(2))
    out.writeBuffer(biomeBytes)
  }
  return out.toBuffer()
}


// ---------------------------------------------------------------------------
// installPacketTap
//
// Hook outgoing serverbound writes on the bot's NMP client (or any NMP
// Client-shaped object) so that for every captured packet we record:
//
//   1. The raw `Buffer` produced by NMP's own serializer — i.e. the bytes
//      that would be handed to the framer / compressor on the wire. We
//      obtain this by calling `client.serializer.createPacketBuffer({ name,
//      params })`, which is the same call NMP's own `Client.write` makes
//      internally via `this.serializer.write({ name, params })`. The capture
//      therefore happens AFTER NMP serialization, not before.
//
//   2. An NMP-deserialized object obtained by feeding that same raw buffer
//      back through a paired deserializer (createDeserializer with the
//      OPPOSITE `isServer` flag for the same state — same pattern as
//      node-minecraft-protocol/test/protocol_26_1.test.js#makeRoundTrip).
//      This lets tests assert on individual fields without having to drive
//      a second (server-side) decoder themselves, while still using bytes
//      that survived the full NMP encode round-trip — so mismatches like
//      missing `sequence` or wrong `flags` shape will surface as either a
//      decode error or a deep-equal divergence between `decoded` and the
//      `originalParams` that mineflayer handed to NMP.
//
// Both views are kept on each entry of `tap.captured`:
//
//   tap.captured = [
//     {
//       name: 'block_dig',
//       rawBytes: Buffer<...>,        // post-NMP-serialization wire bytes
//       hex: '….',                    // convenience hex string
//       decoded: { name, params },    // NMP deserialized form (post-encode)
//       originalParams: { ... },      // params as mineflayer wrote them
//       state: 'play',                // client state at capture time
//       ts: 1234567890                // Date.now() at capture
//     },
//     ...
//   ]
//
// Returns an object exposing `tap.captured` plus helpers:
//   tap.byName(name)        — array filtered to one packet name
//   tap.lastByName(name)    — most recent capture for that name (or null)
//   tap.clear()             — empty `tap.captured`
//   tap.uninstall()         — restore the original `client.write`
//
// Validates: Requirements 1.1, 1.3, 1.5 (post-serialization byte capture +
// retained NMP deserialization for field assertions).
//
// `client` may be either a node-minecraft-protocol Client (i.e.
// `bot._client`) or any object exposing the same `write(name, params)` +
// `serializer` + `state` + `version` + `isServer` surface.
//
// `options.capture` defaults to the six packets the spec calls out.
// Anything not in this set passes through untouched.
//
// `options.onCapture(entry)` is an optional callback invoked synchronously
// after the entry is pushed onto `tap.captured`, useful for tests that want
// to drive an event loop on first capture (e.g. await the first 'flying').
// ---------------------------------------------------------------------------
const DEFAULT_TAP_PACKETS = [
  'block_dig',
  'block_place',
  'flying',
  'position',
  'position_look',
  'look'
]

function installPacketTap (client, options = {}) {
  if (!client || typeof client.write !== 'function') {
    throw new Error('_fixture26_1.installPacketTap: client must expose a write(name, params) method')
  }
  if (!client.version) {
    throw new Error('_fixture26_1.installPacketTap: client.version is required (NMP Client should set it; pass an explicit options.version otherwise)')
  }

  const captureSet = new Set(options.capture || DEFAULT_TAP_PACKETS)
  const onCapture = typeof options.onCapture === 'function' ? options.onCapture : null

  const captured = []

  // Pair a deserializer for each (state, version) on demand. The direction
  // logic mirrors makeRoundTrip in node-minecraft-protocol/test/protocol_26_1.test.js:
  // for an OUTGOING write from a non-server client (`client.isServer === false`),
  // the serializer's direction is `toServer`. To read those bytes back we need
  // a deserializer pointed at the SAME direction, which createDeserializer
  // produces when given the OPPOSITE `isServer` flag.
  //
  // We rebuild the deserializer when the client transitions states (login →
  // configuration → play). The cache is keyed on `(state, version, isServer)`.
  const { createDeserializer } = require('minecraft-protocol')
  const deserializerCache = new Map()
  function getDeserializer () {
    const state = client.state
    const version = client.version
    const isServer = !!client.isServer
    const key = `${state}|${version}|${isServer}`
    let de = deserializerCache.get(key)
    if (!de) {
      de = createDeserializer({
        state,
        version,
        // Opposite-of-client direction — see comment above.
        isServer: !isServer,
        noErrorLogging: true
      })
      deserializerCache.set(key, de)
    }
    return de
  }

  const originalWrite = client.write.bind(client)

  function wrappedWrite (name, params) {
    if (captureSet.has(name)) {
      let rawBytes = null
      let decoded = null
      let captureError = null
      try {
        // (1) After-serialization byte capture. This is the same call that
        // NMP itself makes inside Client.write() → serializer.write(); we run
        // it here explicitly so we can hold the Buffer.
        if (client.serializer && typeof client.serializer.createPacketBuffer === 'function') {
          rawBytes = client.serializer.createPacketBuffer({ name, params })
        }
      } catch (err) {
        captureError = err
      }

      if (rawBytes && !captureError) {
        try {
          // (2) NMP-deserialized companion view — a parsePacketBuffer of the
          // same bytes we just emitted. Errors here usually mean the schema
          // does not round-trip the params we were given (drift / missing
          // field), which is the kind of signal callers want to assert on,
          // so we surface the error inside the entry rather than throwing.
          const parsed = getDeserializer().parsePacketBuffer(rawBytes)
          decoded = parsed.data
        } catch (err) {
          captureError = err
        }
      }

      const entry = {
        name,
        rawBytes,
        hex: rawBytes ? rawBytes.toString('hex') : null,
        decoded,
        originalParams: params,
        state: client.state,
        ts: Date.now(),
        error: captureError
      }
      captured.push(entry)
      if (onCapture) {
        try { onCapture(entry) } catch (cbErr) { /* swallow — tests should not crash on observer */ }
      }
    }

    return originalWrite(name, params)
  }

  client.write = wrappedWrite

  return {
    captured,
    byName (name) {
      return captured.filter(entry => entry.name === name)
    },
    lastByName (name) {
      for (let i = captured.length - 1; i >= 0; i--) {
        if (captured[i].name === name) return captured[i]
      }
      return null
    },
    clear () {
      captured.length = 0
    },
    uninstall () {
      if (client.write === wrappedWrite) {
        client.write = originalWrite
      }
    }
  }
}

module.exports.installPacketTap = installPacketTap
module.exports.DEFAULT_TAP_PACKETS = DEFAULT_TAP_PACKETS


// ---------------------------------------------------------------------------
// protocol775ExpectedShape
//
// Returns the field-set + per-field type descriptor that protocol 775 (the
// 26.1.2 release jar at cache/mojang_26.1.2.jar) expects for a serverbound
// action packet, as read directly off the decompiled `STREAM_CODEC` of the
// corresponding `Serverbound{PlayerAction,UseItemOn}Packet.java`.
//
// The shape is a plain JS array so tests can iterate over expected fields
// (`for (const f of shape.fields) assert(typeof decoded[f.name] === f.jsType)`)
// and is keyed both by the protocol packet name (`'use_item_on'`) and by the
// mineflayer alias for that same packet (`'block_place'`). Both look-ups
// return the SAME descriptor object so callers can use whichever name is
// natural in context (NMP-deserialized packets use the mineflayer alias;
// the cross-check / decompile evidence files use the protocol-spec name).
//
// Truth source per field is annotated inline:
//
//  block_dig  ← decompiled/server/net/minecraft/network/protocol/game/
//                  ServerboundPlayerActionPacket.java#write
//
//      output.writeEnum(this.action);                       // → varint    (status)
//      output.writeBlockPos(this.pos);                      // → position  (location)
//      output.writeByte(this.direction.get3DDataValue());   // → i8        (face)
//      output.writeVarInt(this.sequence);                   // → varint    (sequence)
//
//  use_item_on ← decompiled/server/net/minecraft/network/protocol/game/
//                  ServerboundUseItemOnPacket.java#write
//                  + the inlined BlockHitResult layout
//
//      output.writeEnum(this.hand);                         // → varint    (hand)
//      output.writeBlockHitResult(this.blockHit);
//        ├─ writeBlockPos(blockPos)                         // → position  (location)
//        ├─ writeByte(direction.get3DDataValue())           // → varint    (direction)*
//        ├─ writeFloat(cursor.x)                            // → f32       (cursorX)
//        ├─ writeFloat(cursor.y)                            // → f32       (cursorY)
//        ├─ writeFloat(cursor.z)                            // → f32       (cursorZ)
//        ├─ writeBoolean(insideBlock)                       // → bool      (insideBlock)
//        └─ writeBoolean(worldBorderHit)                    // → bool      (worldBorderHit)  [1.21.3+]
//      output.writeVarInt(this.sequence);                   // → varint    (sequence)
//
//      *Note: at the wire level Direction is a single byte (0..5), but the
//      mineflayer-data 26.1 protocol.json (see node_modules/minecraft-data/.../
//      pc/26.1/protocol.json#packet_block_place) declares the field as
//      `varint`. For values 0..5 the two encodings are byte-identical, so
//      we follow the NMP-declared wire type here — the decoded JS value is
//      a number either way.
//
// Wire-type → JS-type mapping (as produced by the NMP deserializer that
// `installPacketTap` returns on `entry.decoded.params`):
//
//      varint   → 'number' (integer)
//      i8       → 'number' (integer, -128..127)
//      f32      → 'number' (float)
//      bool     → 'boolean'
//      position → 'object' with numeric { x, y, z } members
//
// Each field descriptor exposes:
//   - name:      string                  the field name as it appears in NMP
//                                        params and decompiled STREAM_CODEC
//   - wireType:  string                  the protodef type name from
//                                        minecraft-data 26.1 protocol.json
//   - jsType:    string                  expected typeof the decoded value
//   - check(v):  (value: any) => boolean a predicate that tests both the
//                                        typeof and any sub-shape constraints
//                                        (e.g. position has integer x/y/z)
//
// In addition the returned object provides:
//   - packet:    string                  the canonical protocol-spec packet
//                                        name (e.g. 'use_item_on')
//   - aliases:   string[]                names a test can use to look this
//                                        same shape up (e.g. ['block_place'])
//   - source:    string                  path to the decompiled .java file
//                                        the shape was derived from
//   - fields:    FieldDescriptor[]       ordered list of expected fields
//   - fieldNames(): string[]             names in declaration order
//   - validate(decoded): {
//        ok:         boolean
//        missing:    string[]            field names not present on `decoded`
//        wrongType:  Array<{ name, expected, actualTypeof }>
//        extra:      string[]            fields on `decoded` not in the shape
//      }                                 helper for "iterate over expected
//                                        fields and check types" assertions
//
// Validates: Requirements 2.1 (block_dig field set), 2.3 (use_item_on field set)

const PROTO775_DECOMPILED_BASE =
  'decompiled/server/net/minecraft/network/protocol/game/'

const _PROTO_775_SHAPE_DEFS = {
  block_dig: {
    packet: 'block_dig',
    aliases: [],
    source: PROTO775_DECOMPILED_BASE + 'ServerboundPlayerActionPacket.java',
    fields: [
      // writeEnum(action) → varint mapping: 0..7 over the Action enum
      // (START_DESTROY_BLOCK, ABORT_DESTROY_BLOCK, STOP_DESTROY_BLOCK,
      //  DROP_ALL_ITEMS, DROP_ITEM, RELEASE_USE_ITEM,
      //  SWAP_ITEM_WITH_OFFHAND, STAB).
      { name: 'status', wireType: 'varint', jsType: 'number', check: _isInteger },
      // writeBlockPos(pos) → position (long-packed); NMP decodes to {x,y,z}.
      { name: 'location', wireType: 'position', jsType: 'object', check: _isPosition },
      // writeByte(direction.get3DDataValue()) → i8 in range 0..5.
      { name: 'face', wireType: 'i8', jsType: 'number', check: _isI8 },
      // writeVarInt(sequence) — present since 1.20; mineflayer's digging.js
      // currently OMITS this field, which is the C₁ root cause.
      { name: 'sequence', wireType: 'varint', jsType: 'number', check: _isInteger }
    ]
  },

  use_item_on: {
    packet: 'use_item_on',
    aliases: ['block_place'],
    source: PROTO775_DECOMPILED_BASE + 'ServerboundUseItemOnPacket.java',
    fields: [
      // writeEnum(hand) → varint over InteractionHand (0=MAIN_HAND, 1=OFF_HAND).
      { name: 'hand', wireType: 'varint', jsType: 'number', check: _isInteger },
      // writeBlockHitResult ⟶ inlined {location, direction, cursor*, insideBlock, worldBorderHit}
      { name: 'location', wireType: 'position', jsType: 'object', check: _isPosition },
      // Direction byte at the wire; NMP declares it as varint (byte-identical for 0..5).
      { name: 'direction', wireType: 'varint', jsType: 'number', check: _isInteger },
      // Cursor floats are written by FriendlyByteBuf#writeFloat (single-precision).
      { name: 'cursorX', wireType: 'f32', jsType: 'number', check: _isFiniteNumber },
      { name: 'cursorY', wireType: 'f32', jsType: 'number', check: _isFiniteNumber },
      { name: 'cursorZ', wireType: 'f32', jsType: 'number', check: _isFiniteNumber },
      // writeBoolean(insideBlock) — was already present pre-1.21.3.
      { name: 'insideBlock', wireType: 'bool', jsType: 'boolean', check: _isBoolean },
      // writeBoolean(worldBorderHit) — ADDED in 1.21.3 (protocol 768+); the
      // C₂ defect can be that mineflayer's `block_place` writer omits this
      // bool, which then misaligns the trailing varint sequence on the wire.
      { name: 'worldBorderHit', wireType: 'bool', jsType: 'boolean', check: _isBoolean },
      // writeVarInt(sequence) — same BlockBreakSequenceId protocol as block_dig.
      { name: 'sequence', wireType: 'varint', jsType: 'number', check: _isInteger }
    ]
  }
}

// Type-predicate helpers. Kept module-private; if a test wants to assert on
// a single field directly it can read `descriptor.fields[i].check`.
function _isInteger (v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
}

function _isI8 (v) {
  return _isInteger(v) && v >= -128 && v <= 127
}

function _isFiniteNumber (v) {
  // f32: any JS number (including non-integers); rules out NaN / Infinity
  // because the protodef writer would have rejected those upstream.
  return typeof v === 'number' && Number.isFinite(v)
}

function _isBoolean (v) {
  return typeof v === 'boolean'
}

function _isPosition (v) {
  return v !== null && typeof v === 'object' &&
    _isInteger(v.x) && _isInteger(v.y) && _isInteger(v.z)
}

// Build the public lookup table. Each entry is shared by reference between
// the canonical packet name and any aliases so identity comparisons succeed.
const _PROTO_775_SHAPE_TABLE = (() => {
  const table = {}
  for (const def of Object.values(_PROTO_775_SHAPE_DEFS)) {
    const descriptor = Object.freeze({
      packet: def.packet,
      aliases: Object.freeze([...def.aliases]),
      source: def.source,
      fields: Object.freeze(def.fields.map(f => Object.freeze({ ...f }))),
      fieldNames () {
        return def.fields.map(f => f.name)
      },
      validate (decoded) {
        const missing = []
        const wrongType = []
        const extra = []
        const decodedKeys = decoded && typeof decoded === 'object'
          ? Object.keys(decoded)
          : []
        const fieldNameSet = new Set(def.fields.map(f => f.name))

        for (const field of def.fields) {
          if (!decoded || !(field.name in decoded)) {
            missing.push(field.name)
            continue
          }
          const value = decoded[field.name]
          if (!field.check(value)) {
            wrongType.push({
              name: field.name,
              expected: `${field.wireType} (typeof ${field.jsType})`,
              actualTypeof: value === null ? 'null' : typeof value
            })
          }
        }
        for (const k of decodedKeys) {
          if (!fieldNameSet.has(k)) extra.push(k)
        }
        return {
          ok: missing.length === 0 && wrongType.length === 0,
          missing,
          wrongType,
          extra
        }
      }
    })
    table[def.packet] = descriptor
    for (const alias of def.aliases) {
      table[alias] = descriptor
    }
  }
  return Object.freeze(table)
})()

function protocol775ExpectedShape (packetName) {
  if (typeof packetName !== 'string') {
    throw new TypeError(
      `_fixture26_1.protocol775ExpectedShape: packetName must be a string, got ${typeof packetName}`
    )
  }
  const descriptor = _PROTO_775_SHAPE_TABLE[packetName]
  if (!descriptor) {
    const known = Object.keys(_PROTO_775_SHAPE_TABLE).sort().join(', ')
    throw new Error(
      `_fixture26_1.protocol775ExpectedShape: no shape declared for '${packetName}' ` +
      `at protocol 775 (known: ${known}). ` +
      `Add it to _PROTO_775_SHAPE_DEFS once the corresponding decompiled STREAM_CODEC ` +
      `is captured under decompiled/server/net/minecraft/network/protocol/game/.`
    )
  }
  return descriptor
}

module.exports.protocol775ExpectedShape = protocol775ExpectedShape
// Exported for tests that want to enumerate every known shape.
module.exports.PROTOCOL_775_SHAPE_NAMES = Object.freeze(
  Object.keys(_PROTO_775_SHAPE_TABLE).sort()
)

// ---------------------------------------------------------------------------
// recordWireBytes
//
// Snapshot helper for the §6 P₁ "old-protocol byte equivalence" preservation
// property. Stores the post-NMP-serialization wire bytes of a single
// serverbound packet as a hex blob keyed by (packetName, protocolVersion):
//
//     mineflayer/test/snapshots/preservation/<packetName>.<protocolVersion>.bytes
//
// Two modes:
//
//   - UPDATE mode  — writes the hex string to the snapshot file, overwriting
//                    any previous contents. Triggered EXPLICITLY by either:
//                      (a) env var  UPDATE_SNAPSHOTS=1
//                      (b) process.argv  contains '--update-snapshots'
//                    Tests on the main path (no env, no flag) NEVER write
//                    the file — that's a strict requirement of task 1.4.
//
//   - VERIFY mode  — (the default; a.k.a. main-path) reads the snapshot file
//                    and asserts assert.strictEqual(actualHex, snapshotHex).
//                    On a mismatch we throw an AssertionError so mocha
//                    surfaces the diff with the captured-vs-snapshot bytes
//                    and a hint about how to regenerate via UPDATE mode.
//                    On a missing snapshot the error message also points the
//                    operator at UPDATE_SNAPSHOTS=1.
//
// Why hex (not raw binary)? Hex is plaintext, line-stable across git, and
// trivially diffable in PR review — the C₂ root cause was discovered exactly
// this way (a leftover byte at the tail of the wire buffer). Storing as hex
// also avoids the BOM / line-ending pitfalls of binary snapshots on Windows.
//
// Inputs (object form):
//   - protocolVersion: number (required)   the protocol number this snapshot
//                                          is keyed under (e.g. 769, 765, 775)
//   - packetName:      string (required)   the protocol-spec packet name as
//                                          tap.captured[i].name records it
//                                          (e.g. 'block_dig', 'block_place')
//   - rawBytes:        Buffer (required)   the post-NMP-serialization bytes,
//                                          typically tap.lastByName(name).rawBytes
//                                          or any other Buffer the test
//                                          assembled directly.
//   - mode:            string (optional)   override the auto-detected mode.
//                                          Accepts 'update' | 'verify' | 'auto'.
//                                          Default 'auto' (env / argv based).
//   - snapshotsDir:    string (optional)   override the snapshots root.
//                                          Defaults to
//                                          mineflayer/test/snapshots/preservation
//                                          relative to this file. Tests can
//                                          point this at a temp dir to keep
//                                          the helper hermetic in unit tests.
//
// Returns:
//   { mode, hex, snapshotPath, action }
//     - mode:         'update' | 'verify'  the effective mode after auto-detect
//     - hex:          string                lowercase hex of rawBytes (no '0x')
//     - snapshotPath: string                absolute path of the .bytes file
//     - action:       'wrote' | 'matched'   what the call did
//
// Throws:
//   - TypeError on argument shape errors (caught early before any IO)
//   - AssertionError on verify-mode mismatch — message contains both hex
//     strings plus the snapshot path and an UPDATE_SNAPSHOTS hint
//   - Error('snapshot missing: …') in verify mode when the snapshot does
//     not exist — also includes the UPDATE_SNAPSHOTS hint
//
// Validates: Requirements 3.1 (旧协议字节等价快照), 3.7 (P₇ 非缺陷输入等价基线)
// Preservation: P₁, P₇

const _fs = require('fs')
const _path = require('path')
const _assert = require('assert')

// Default snapshots directory: <repo>/mineflayer/test/snapshots/preservation
// Computed once relative to this util file so the path is stable regardless
// of where mocha is invoked from (cwd may be the repo root or mineflayer/).
const DEFAULT_SNAPSHOTS_DIR = _path.resolve(__dirname, '..', 'snapshots', 'preservation')

function _isUpdateSnapshotsRequested () {
  // (a) explicit env var — works in CI and on Windows cmd via `set UPDATE_SNAPSHOTS=1 && …`.
  if (process.env.UPDATE_SNAPSHOTS && process.env.UPDATE_SNAPSHOTS !== '0' && process.env.UPDATE_SNAPSHOTS !== '') {
    return true
  }
  // (b) explicit argv flag — survives `mocha --run` because it shows up in
  // process.argv as a positional after mocha's known flags. We accept both
  // bare '--update-snapshots' and the value-form '--update-snapshots=1'.
  if (Array.isArray(process.argv)) {
    for (const arg of process.argv) {
      if (arg === '--update-snapshots') return true
      if (typeof arg === 'string' && arg.startsWith('--update-snapshots=')) {
        const v = arg.slice('--update-snapshots='.length)
        return v !== '0' && v !== '' && v.toLowerCase() !== 'false'
      }
    }
  }
  return false
}

function _resolveSnapshotPath (snapshotsDir, packetName, protocolVersion) {
  // packetName is part of a filesystem path → reject anything that contains
  // a separator or '..' so a malicious / malformed test cannot escape the
  // snapshots directory.
  if (packetName.includes('/') || packetName.includes('\\') || packetName.includes('..')) {
    throw new TypeError(
      `_fixture26_1.recordWireBytes: packetName '${packetName}' must not contain path separators or '..'`
    )
  }
  return _path.join(snapshotsDir, `${packetName}.${protocolVersion}.bytes`)
}

function _formatHexDiffPreview (actualHex, snapshotHex) {
  // Find the first differing offset to make the assertion message actionable
  // when the buffers are long.
  const len = Math.min(actualHex.length, snapshotHex.length)
  let diffAt = -1
  for (let i = 0; i < len; i++) {
    if (actualHex[i] !== snapshotHex[i]) { diffAt = i; break }
  }
  if (diffAt === -1 && actualHex.length !== snapshotHex.length) {
    diffAt = len
  }
  if (diffAt === -1) return '(buffers identical)'
  // Each byte is two hex chars; report byte offset for human-readable output.
  const byteOffset = Math.floor(diffAt / 2)
  const window = 16 // 16 bytes = 32 hex chars on each side
  const start = Math.max(0, diffAt - window)
  const end = Math.min(Math.max(actualHex.length, snapshotHex.length), diffAt + window)
  return [
    `first byte mismatch at offset ${byteOffset}`,
    `  actual:   …${actualHex.slice(start, end)}…`,
    `  snapshot: …${snapshotHex.slice(start, end)}…`,
    `  actual length:   ${actualHex.length / 2} bytes`,
    `  snapshot length: ${snapshotHex.length / 2} bytes`
  ].join('\n')
}

function recordWireBytes (options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('_fixture26_1.recordWireBytes: options must be an object')
  }
  const { protocolVersion, packetName, rawBytes } = options
  const snapshotsDir = options.snapshotsDir || DEFAULT_SNAPSHOTS_DIR
  const explicitMode = options.mode

  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion) || protocolVersion <= 0) {
    throw new TypeError(
      `_fixture26_1.recordWireBytes: protocolVersion must be a positive integer, got ${protocolVersion}`
    )
  }
  if (typeof packetName !== 'string' || packetName.length === 0) {
    throw new TypeError(
      `_fixture26_1.recordWireBytes: packetName must be a non-empty string, got ${typeof packetName}`
    )
  }
  if (!Buffer.isBuffer(rawBytes)) {
    throw new TypeError(
      `_fixture26_1.recordWireBytes: rawBytes must be a Buffer (got ${rawBytes === null ? 'null' : typeof rawBytes}). ` +
      `Tests typically pass tap.lastByName('${packetName}').rawBytes here.`
    )
  }
  if (explicitMode !== undefined && explicitMode !== 'update' && explicitMode !== 'verify' && explicitMode !== 'auto') {
    throw new TypeError(
      `_fixture26_1.recordWireBytes: mode must be 'update' | 'verify' | 'auto' (or omitted), got '${explicitMode}'`
    )
  }

  const mode = (explicitMode === undefined || explicitMode === 'auto')
    ? (_isUpdateSnapshotsRequested() ? 'update' : 'verify')
    : explicitMode

  const snapshotPath = _resolveSnapshotPath(snapshotsDir, packetName, protocolVersion)
  const actualHex = rawBytes.toString('hex')

  if (mode === 'update') {
    // Make sure the parent directory exists. recursive: true is a no-op when
    // the directory already exists, which is the common case.
    _fs.mkdirSync(_path.dirname(snapshotPath), { recursive: true })
    // Trailing newline keeps `git diff` and `cat` output sane.
    _fs.writeFileSync(snapshotPath, actualHex + '\n', { encoding: 'utf8' })
    return { mode, hex: actualHex, snapshotPath, action: 'wrote' }
  }

  // mode === 'verify' — main-path: read snapshot, assert equality, NEVER write.
  if (!_fs.existsSync(snapshotPath)) {
    throw new Error(
      `_fixture26_1.recordWireBytes: snapshot missing: ${snapshotPath}\n` +
      `  packetName=${packetName} protocolVersion=${protocolVersion}\n` +
      '  Re-run with UPDATE_SNAPSHOTS=1 (or --update-snapshots) to create it,\n' +
      '  e.g. on Windows cmd:  set UPDATE_SNAPSHOTS=1 && npx mocha … --run'
    )
  }
  const fileContents = _fs.readFileSync(snapshotPath, { encoding: 'utf8' })
  // Be tolerant of whitespace / newlines added by editors. The recorded
  // payload is always lowercase-hex of even length, so trimming is safe.
  const snapshotHex = fileContents.trim()

  if (actualHex !== snapshotHex) {
    const preview = _formatHexDiffPreview(actualHex, snapshotHex)
    const err = new _assert.AssertionError({
      message:
        '_fixture26_1.recordWireBytes: wire-bytes snapshot mismatch\n' +
        `  packet:        ${packetName}\n` +
        `  protocol:      ${protocolVersion}\n` +
        `  snapshot path: ${snapshotPath}\n` +
        preview + '\n' +
        '  Re-run with UPDATE_SNAPSHOTS=1 (or --update-snapshots) to refresh the snapshot\n' +
        '  ONLY if the change in serialization is intentional and review-approved\n' +
        '  (P₁ requires byte-equivalence on protocols ≠ 775).',
      actual: actualHex,
      expected: snapshotHex,
      operator: 'strictEqual',
      stackStartFn: recordWireBytes
    })
    throw err
  }

  return { mode, hex: actualHex, snapshotPath, action: 'matched' }
}

module.exports.recordWireBytes = recordWireBytes
module.exports.DEFAULT_SNAPSHOTS_DIR = DEFAULT_SNAPSHOTS_DIR
// Exported as an internal so a small unit test can drive the env / argv
// detection without poking process.env from a parent describe block.
module.exports._isUpdateSnapshotsRequested = _isUpdateSnapshotsRequested
