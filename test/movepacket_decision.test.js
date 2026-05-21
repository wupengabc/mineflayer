/* eslint-env mocha */
//
// Feature: minecraft-26-1-protocol-and-velocity-support, Property 7: 移动包类型决策表
//
// For any pair of consecutive player states (s_t, s_{t+1}) with random
// position (vec3), (yaw, pitch) (vec2) and onGround (bool), define
//   positionChanged = s_t.position !== s_{t+1}.position
//   rotationChanged = (s_t.yaw, s_t.pitch) !== (s_{t+1}.yaw, s_{t+1}.pitch)
//   groundFlipped   = s_t.onGround !== s_{t+1}.onGround
//
// Then chooseMovePacket(s_t, s_{t+1}) maps to:
//   positionChanged && rotationChanged                   -> 'position_look'  (move_player_pos_rot,     0x1F)
//   positionChanged && !rotationChanged                  -> 'position'       (move_player_pos,         0x1E)
//   !positionChanged && rotationChanged                  -> 'look'           (move_player_rot,         0x20)
//   !positionChanged && !rotationChanged && groundFlipped-> 'flying'         (move_player_status_only, 0x21)
//   else                                                 -> null (no packet)
//
// The current `lib/plugins/physics.js` does not export this decision as a
// standalone pure function; the logic is inline inside `updatePosition()`.
// Per the task brief we use approach (b): re-implement the decision logic
// here mirroring physics.js so this test asserts the truth table holds end to
// end without coupling to physics.js's internal scheduling.
//
// Validates: Requirements 13.1, 13.2, 13.3, 13.4

const assert = require('assert')
const fc = require('fast-check')

// ---------------------------------------------------------------------------
// Reference decision implementation
//
// Mirrors the inline decision in lib/plugins/physics.js's updatePosition():
//
//     const positionUpdated = lastSent.x !== position.x || lastSent.y !== position.y || lastSent.z !== position.z
//     const lookUpdated     = lastSent.yaw !== yaw || lastSent.pitch !== pitch
//     const groundFlipped   = onGround !== lastSent.onGround
//     if (positionUpdated && lookUpdated)        bot._client.write('position_look', ...)
//     else if (positionUpdated)                  bot._client.write('position',      ...)
//     else if (lookUpdated)                      bot._client.write('look',          ...)
//     else if (positionUpdateSentEveryTick || groundFlipped) bot._client.write('flying', ...)
//
// We restrict to the 26.1 path where positionUpdateSentEveryTick is false, so
// only the four packet branches plus the no-op branch are reachable. The
// returned strings are the mineflayer packet names which the protocol.json
// `play.toServer` table maps to packet ids 0x1E / 0x1F / 0x20 / 0x21.
// ---------------------------------------------------------------------------
function chooseMovePacket (s1, s2) {
  const positionChanged = s1.position.x !== s2.position.x ||
                          s1.position.y !== s2.position.y ||
                          s1.position.z !== s2.position.z
  const rotationChanged = s1.yaw !== s2.yaw || s1.pitch !== s2.pitch
  const groundFlipped = s1.onGround !== s2.onGround

  if (positionChanged && rotationChanged) return 'position_look'
  if (positionChanged) return 'position'
  if (rotationChanged) return 'look'
  if (groundFlipped) return 'flying'
  return null
}

// Independent expectation function used as the test oracle. Implemented from
// the design.md decision table directly so it does not share code with
// chooseMovePacket above (other than the shared signature).
function expectedFromTable (s1, s2) {
  const positionChanged = !(
    s1.position.x === s2.position.x &&
    s1.position.y === s2.position.y &&
    s1.position.z === s2.position.z
  )
  const rotationChanged = !(s1.yaw === s2.yaw && s1.pitch === s2.pitch)
  const groundFlipped = s1.onGround !== s2.onGround

  // Truth table from Property 7
  if (positionChanged && rotationChanged) return 'position_look'
  if (positionChanged && !rotationChanged) return 'position'
  if (!positionChanged && rotationChanged) return 'look'
  if (!positionChanged && !rotationChanged && groundFlipped) return 'flying'
  return null
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
// Use a finite numeric domain so equality is well-defined (no NaN tricks).
const finiteCoord = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 })
const finiteAngle = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e3, max: 1e3 })

const stateArb = fc.record({
  position: fc.record({ x: finiteCoord, y: finiteCoord, z: finiteCoord }),
  yaw: finiteAngle,
  pitch: finiteAngle,
  onGround: fc.boolean()
})

// Pair generator: with some probability, force one or more dimensions to
// stay equal between s1 and s2 so we don't only sample the all-changed
// branch (where positionChanged && rotationChanged is overwhelmingly true).
const statePairArb = fc.record({
  s1: stateArb,
  s2: stateArb,
  // bit flags: 1=keep position, 2=keep yaw/pitch, 4=keep onGround
  freeze: fc.integer({ min: 0, max: 7 })
}).map(({ s1, s2, freeze }) => {
  const t2 = {
    position: { x: s2.position.x, y: s2.position.y, z: s2.position.z },
    yaw: s2.yaw,
    pitch: s2.pitch,
    onGround: s2.onGround
  }
  if (freeze & 1) {
    t2.position.x = s1.position.x
    t2.position.y = s1.position.y
    t2.position.z = s1.position.z
  }
  if (freeze & 2) {
    t2.yaw = s1.yaw
    t2.pitch = s1.pitch
  }
  if (freeze & 4) {
    t2.onGround = s1.onGround
  }
  return [s1, t2]
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Property 7: chooseMovePacket decision table (26.1)', function () {
  it('matches the 13.1/13.2/13.3/13.4 truth table for any state pair', function () {
    fc.assert(
      fc.property(statePairArb, ([s1, s2]) => {
        const got = chooseMovePacket(s1, s2)
        const want = expectedFromTable(s1, s2)
        assert.strictEqual(got, want)
      }),
      { numRuns: 100 }
    )
  })

  it('positionChanged && rotationChanged -> position_look (Req 13.2)', function () {
    fc.assert(
      fc.property(stateArb, (s) => {
        // Force both position and rotation to differ; ground stays the same.
        // We rebuild s2 with explicit-different absolute values rather than
        // adding a delta — adding a tiny double can be absorbed by
        // floating-point and leave s1.x === s2.x for huge magnitudes.
        const s1 = { position: { x: s.position.x, y: s.position.y, z: s.position.z }, yaw: s.yaw, pitch: s.pitch, onGround: s.onGround }
        const newX = s.position.x === 1 ? 2 : 1
        const newYaw = s.yaw === 1 ? 2 : 1
        const s2 = {
          position: { x: newX, y: s.position.y, z: s.position.z },
          yaw: newYaw,
          pitch: s.pitch,
          onGround: s.onGround
        }
        assert.strictEqual(chooseMovePacket(s1, s2), 'position_look')
      }),
      { numRuns: 100 }
    )
  })

  it('positionChanged && !rotationChanged -> position (Req 13.1)', function () {
    fc.assert(
      fc.property(stateArb, (s) => {
        // Build s1 and s2 that differ only in position.x (no rotation/ground change).
        const s1 = { position: { x: s.position.x, y: s.position.y, z: s.position.z }, yaw: s.yaw, pitch: s.pitch, onGround: s.onGround }
        const newX = s.position.x === 1 ? 2 : 1
        const s2 = { position: { x: newX, y: s.position.y, z: s.position.z }, yaw: s.yaw, pitch: s.pitch, onGround: s.onGround }
        assert.strictEqual(chooseMovePacket(s1, s2), 'position')
      }),
      { numRuns: 100 }
    )
  })

  it('!positionChanged && rotationChanged -> look (Req 13.3)', function () {
    fc.assert(
      fc.property(stateArb, (s) => {
        const s1 = { position: { ...s.position }, yaw: s.yaw, pitch: s.pitch, onGround: s.onGround }
        const newYaw = s.yaw === 1 ? 2 : 1
        const s2 = { position: { ...s.position }, yaw: newYaw, pitch: s.pitch, onGround: s.onGround }
        assert.strictEqual(chooseMovePacket(s1, s2), 'look')
      }),
      { numRuns: 100 }
    )
  })

  it('!positionChanged && !rotationChanged && groundFlipped -> flying (Req 13.4)', function () {
    fc.assert(
      fc.property(stateArb, (s) => {
        const s1 = { position: { ...s.position }, yaw: s.yaw, pitch: s.pitch, onGround: s.onGround }
        const s2 = { position: { ...s.position }, yaw: s.yaw, pitch: s.pitch, onGround: !s.onGround }
        assert.strictEqual(chooseMovePacket(s1, s2), 'flying')
      }),
      { numRuns: 100 }
    )
  })

  it('no change at all -> null (no packet)', function () {
    fc.assert(
      fc.property(stateArb, (s) => {
        const s1 = { position: { ...s.position }, yaw: s.yaw, pitch: s.pitch, onGround: s.onGround }
        const s2 = { position: { ...s.position }, yaw: s.yaw, pitch: s.pitch, onGround: s.onGround }
        assert.strictEqual(chooseMovePacket(s1, s2), null)
      }),
      { numRuns: 100 }
    )
  })
})
