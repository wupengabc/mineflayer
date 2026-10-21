'use strict'
/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const protocol = require('minecraft-protocol')
const conv = require('../lib/conversions')
const injectEntities = require('../lib/plugins/entities')
const [readVarInt] = require('protodef').types.varint

function close (actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)
}

function vector (actual, expected) {
  for (const key of ['x', 'y', 'z']) close(actual[key], expected[key])
}

function makeBot (version) {
  const bot = new EventEmitter()
  bot.version = version
  bot.registry = require('prismarine-registry')(version)
  bot.protocolVersion = bot.registry.version.version
  bot.supportFeature = bot.registry.supportFeature
  bot._client = new EventEmitter()
  injectEntities(bot)
  const entity = bot.entities[42] = {
    id: 42,
    position: new Vec3(10, 20, 30),
    velocity: new Vec3(1, 2, 3),
    yaw: conv.fromNotchianYaw(30),
    pitch: conv.fromNotchianPitch(20),
    onGround: false
  }
  const serializer = protocol.createSerializer({ version, state: 'play', isServer: true })
  const parser = protocol.createDeserializer({ version, state: 'play', isServer: false, noErrorLogging: true })
  let events = 0
  bot.on('entityMoved', moved => {
    assert.strictEqual(moved, entity)
    events++
  })
  function receive (name, params, expectedPayload) {
    const bytes = serializer.createPacketBuffer({ name, params: { entityId: 42, ...params } })
    // Payload fixtures are independently written from the Mojmap stream codecs.
    if (expectedPayload) assert.deepStrictEqual(bytes.subarray(readVarInt(bytes, 0).size), expectedPayload)
    const decoded = parser.parsePacketBuffer(bytes)
    assert.strictEqual(decoded.metadata.size, bytes.length)
    assert.strictEqual(decoded.data.name, name)
    const before = events
    bot._client.emit(name, decoded.data.params)
    const moves = ['entity_teleport', 'rel_entity_move', 'entity_move_look', 'sync_entity_position'].includes(name)
    assert.strictEqual(events, before + (moves ? 1 : 0))
    return decoded.data.params
  }
  return { bot, entity, receive }
}

function teleportPayload (packet) {
  // ClientboundTeleportEntityPacket: id, PositionMoveRotation, Relative INT, BOOL.
  const bytes = Buffer.alloc(62)
  bytes.writeUInt8(42, 0)
  for (const [i, field] of ['x', 'y', 'z', 'dx', 'dy', 'dz'].entries()) bytes.writeDoubleBE(packet[field], 1 + i * 8)
  bytes.writeFloatBE(packet.yaw, 49)
  bytes.writeFloatBE(packet.pitch, 53)
  bytes.writeUInt32BE(packet.flags, 57)
  bytes.writeUInt8(packet.onGround ? 1 : 0, 61)
  return bytes
}

describe('vanilla incoming entity movement with real codecs', function () {
  for (const version of ['26.2', '26.3']) {
    it(`${version}: teleports with float degrees and absolute velocity`, function () {
      const { entity, receive } = makeBot(version)
      const packet = { x: -12.25, y: 64.5, z: 123.75, dx: 0.25, dy: -0.5, dz: 2, yaw: 140.5, pitch: -31.25, flags: 0, onGround: true }
      receive('entity_teleport', packet, teleportPayload(packet))
      vector(entity.position, new Vec3(packet.x, packet.y, packet.z))
      vector(entity.velocity, new Vec3(packet.dx, packet.dy, packet.dz))
      close(entity.yaw, conv.fromNotchianYaw(packet.yaw))
      close(entity.pitch, conv.fromNotchianPitch(packet.pitch))
      assert.strictEqual(entity.onGround, true)
    })

    it(`${version}: keeps position and velocity relative flags independent`, function () {
      const { entity, receive } = makeBot(version)
      const packet = { x: 0.5, y: -5, z: 2, dx: 10, dy: 20, dz: 30, yaw: 15, pitch: 100, flags: 1 | 4 | 8 | 16 | 64, onGround: false }
      receive('entity_teleport', packet, teleportPayload(packet))
      vector(entity.position, new Vec3(10.5, -5, 32))
      vector(entity.velocity, new Vec3(10, 22, 30))
      close(entity.yaw, conv.fromNotchianYaw(45))
      close(entity.pitch, conv.fromNotchianPitch(90))
      assert.strictEqual(entity.onGround, false)
    })

    it(`${version}: rotates source velocity around X then Y before adding relative axes`, function () {
      const { entity, receive } = makeBot(version)
      entity.yaw = conv.fromNotchianYaw(0)
      entity.pitch = conv.fromNotchianPitch(0)
      const packet = { x: 0, y: 0, z: 0, dx: 0.25, dy: 0.5, dz: 0.75, yaw: 90, pitch: 90, flags: 32 | 64 | 128 | 256, onGround: true }
      receive('entity_teleport', packet, teleportPayload(packet))
      vector(entity.velocity, new Vec3(-1.75, -2.5, 1.75))
      // With no relative velocity flags ROTATE_DELTA cannot retain source axes.
      receive('entity_teleport', { ...packet, flags: 256 })
      vector(entity.velocity, new Vec3(0.25, 0.5, 0.75))
    })

    it(`${version}: leaves velocity unchanged on ordinary relative movement`, function () {
      const { entity, receive } = makeBot(version)
      const delta = { dX: 0.5, dY: -0.25, dZ: 1, onGround: true, steps: [] }
      receive('rel_entity_move', version === '26.3'
        ? { delta }
        : { dX: 2048, dY: -1024, dZ: 4096, onGround: true })
      vector(entity.position, new Vec3(10.5, 19.75, 31))
      vector(entity.velocity, new Vec3(1, 2, 3))
      assert.strictEqual(entity.onGround, true)
    })

    it(`${version}: replaces passenger lists on repeat, transfer, omission and empty updates`, function () {
      const { bot, entity, receive } = makeBot(version)
      bot.entity = bot.entities[1] = { id: 1, vehicle: null, passengers: [] }
      const other = bot.entities[2] = { id: 2, vehicle: null, passengers: [] }
      const secondVehicle = bot.entities[43] = { id: 43, passengers: [] }
      entity.passengers = []
      let mounts = 0
      const dismounts = []
      bot.on('mount', () => { mounts++ })
      bot.on('dismount', vehicle => { dismounts.push(vehicle) })
      receive('set_passengers', { passengers: [1, 2] })
      assert.deepStrictEqual(entity.passengers, [bot.entity, other])
      assert.strictEqual(bot.vehicle, entity)
      receive('set_passengers', { passengers: [1, 2] })
      assert.deepStrictEqual(entity.passengers, [bot.entity, other])
      assert.strictEqual(mounts, 1)
      receive('set_passengers', { passengers: [1] })
      assert.strictEqual(other.vehicle, null)
      receive('set_passengers', { entityId: 43, passengers: [1] })
      assert.deepStrictEqual(entity.passengers, [])
      assert.strictEqual(bot.vehicle, secondVehicle)
      assert.strictEqual(bot.entity.vehicle, secondVehicle)
      assert.strictEqual(mounts, 2)
      assert.deepStrictEqual(dismounts, [entity])
      receive('set_passengers', { entityId: 43, passengers: [] })
      assert.strictEqual(bot.vehicle, null)
      assert.strictEqual(bot.entity.vehicle, null)
      assert.deepStrictEqual(secondVehicle.passengers, [])
      assert.deepStrictEqual(dismounts, [entity, secondVehicle])
      receive('set_passengers', { entityId: 999, passengers: [1] })
      assert.strictEqual(bot.entities[999], undefined)
    })

    it(`${version}: leash links leave the riding graph unchanged and detach with ID zero`, function () {
      const { bot, entity, receive } = makeBot(version)
      const vehicle = bot.entities[43] = { id: 43, passengers: [entity] }
      bot.entity = entity
      bot.vehicle = vehicle
      entity.vehicle = vehicle
      for (const event of ['mount', 'dismount', 'entityAttach', 'entityDetach']) {
        bot.on(event, () => assert.fail(`leash triggered ${event}`))
      }
      receive('attach_entity', { vehicleId: 99 })
      assert.strictEqual(entity.leashHolderId, 99)
      assert.strictEqual(bot.entities[99], undefined, 'leash holder can arrive later')
      assert.strictEqual(entity.vehicle, vehicle)
      assert.strictEqual(bot.vehicle, vehicle)
      assert.deepStrictEqual(vehicle.passengers, [entity])
      receive('attach_entity', { vehicleId: 0 })
      assert.strictEqual(entity.leashHolderId, 0)
      assert.strictEqual(bot.entities[0], undefined)
      assert.strictEqual(entity.vehicle, vehicle)
    })

    it(`${version}: maps animation IDs to the matching entity events`, function () {
      const { bot, entity, receive } = makeBot(version)
      const names = ['entitySwingArm', 'entityHurt', 'entityWake', 'entityEat', 'entityCriticalEffect', 'entityMagicCriticalEffect']
      const observed = []
      for (const name of names) {
        bot.on(name, value => {
          assert.strictEqual(value, entity)
          observed.push(name)
        })
      }
      for (let animation = 0; animation < (version === '26.3' ? 3 : 6); animation++) receive('animation', { animation })
      assert.deepStrictEqual(observed, version === '26.3' ? ['entityWake', 'entityCriticalEffect', 'entityMagicCriticalEffect'] : names)
      if (version === '26.3') {
        receive('swing_animation', { hand: 1, animation: { type: 1, duration: 7 } })
        assert.strictEqual(observed.at(-1), 'entitySwingArm')
      }
    })
  }

  it('26.3: sums all stepped move/look deltas and keeps byte rotations', function () {
    const { entity, receive } = makeBot('26.3')
    const packet = receive('entity_move_look', {
      delta: { onGround: true, steps: [{ ticks: 1, x: 1, y: 0.5, z: -1 }, { ticks: 3, x: 2, y: -0.25, z: 0.5 }] },
      yaw: 64,
      pitch: -32
    }, Buffer.from('2a050110000800f000032000fc00080040e0', 'hex'))
    assert.strictEqual(packet.delta.dX, 3)
    vector(entity.position, new Vec3(13, 20.25, 29.5))
    vector(entity.velocity, new Vec3(1, 2, 3))
    close(entity.yaw, conv.fromNotchianYaw(90))
    close(entity.pitch, conv.fromNotchianPitch(-45))
    assert.strictEqual(entity.onGround, true)
  })

  it('26.3: rounds only touched base axes, including steps whose sum is zero', function () {
    const { entity, receive } = makeBot('26.3')
    entity.position.set(10.0001, 20.0001, 30.0001)
    receive('rel_entity_move', { delta: { onGround: false, steps: [{ ticks: 1, x: 1, y: 0, z: 0 }, { ticks: 2, x: -1, y: 0, z: 0 }] } })
    vector(entity.position, new Vec3(10, 20.0001, 30.0001))
    receive('rel_entity_move', { delta: { dX: 0, dY: 1 / 4096, dZ: 0, onGround: true } })
    vector(entity.position, new Vec3(10, 20 + 1 / 4096, 30.0001))
  })

  for (const type of ['linear', 'stepped']) {
    it(`26.3: uses the ${type} sync path endpoint without inventing velocity`, function () {
      const { entity, receive } = makeBot('26.3')
      const endPosition = { x: 123.125, y: 75.25, z: -14.5 }
      const path = type === 'linear'
        ? { endPosition }
        : { steps: [{ position: { x: 11, y: 22, z: 33 }, tickOffset: 2 }, { position: endPosition, tickOffset: 128 }] }
      receive('sync_entity_position', { position: { type, path }, yaw: 120.5, pitch: 30.25, onGround: true })
      vector(entity.position, endPosition)
      vector(entity.velocity, new Vec3(1, 2, 3))
      close(entity.yaw, conv.fromNotchianYaw(120.5))
      close(entity.pitch, conv.fromNotchianPitch(30.25))
      assert.strictEqual(entity.onGround, true)
      receive('rel_entity_move', { delta: { dX: 0.5, dY: 0, dZ: -0.25, onGround: false } })
      vector(entity.position, new Vec3(123.625, 75.25, -14.75))
    })
  }

  it('26.2: retains the flat position sync velocity fields', function () {
    const { entity, receive } = makeBot('26.2')
    receive('sync_entity_position', { x: -4, y: 50, z: 8, dx: -0.125, dy: 0.5, dz: 1.25, yaw: 45.5, pitch: 12.25, onGround: true })
    vector(entity.position, new Vec3(-4, 50, 8))
    vector(entity.velocity, new Vec3(-0.125, 0.5, 1.25))
  })

  it('1.21.1: preserves the legacy byte-rotation teleport layout', function () {
    const { entity, receive } = makeBot('1.21.1')
    receive('entity_teleport', { x: 1, y: 64, z: 3, yaw: 64, pitch: 32, onGround: false })
    vector(entity.position, new Vec3(1, 64, 3))
    vector(entity.velocity, new Vec3(1, 2, 3))
    close(entity.yaw, conv.fromNotchianYaw(90))
    close(entity.pitch, conv.fromNotchianPitch(45))
  })
})
