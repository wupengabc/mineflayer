const { Vec3 } = require('vec3')

const ENTITY_PICK_RADIUS = 0.1
const ATTACKABLE_OBJECTS = new Set([
  'armor_stand',
  'boat',
  'chest_boat',
  'furnace_minecart',
  'hopper_minecart',
  'minecart',
  'tnt_minecart',
  'command_block_minecart',
  'ender_crystal',
  'item_frame',
  'glow_item_frame',
  'painting',
  'interaction'
])

// Java 26.3: LivingEntity.isPickable (minecraft-data splits living entities
// across these groups), plus the non-living isPickable overrides below.
const LIVING_TYPES = new Set(['living', 'player', 'mob', 'animal', 'ambient', 'hostile', 'water_creature', 'passive'])
const PICKABLE_NON_LIVING = new Set([
  'end_crystal', 'ender_crystal', 'falling_block', 'tnt', 'interaction',
  'cushion', 'item_frame', 'glow_item_frame', 'leash_knot', 'painting'
])
// EntityTypeTagsProvider.REDIRECTABLE_PROJECTILE. ShulkerBullet separately
// overrides isPickable and inherits Projectile's pick radius of 1.
const PICKABLE_PROJECTILES = new Set(['fireball', 'wind_charge', 'breeze_wind_charge', 'shulker_bullet'])

function interactionRange (entity, key, fallback) {
  const attribute = entity.attributes?.[`player.${key}`]
  if (!attribute) return fallback
  const modifiers = attribute.modifiers ?? []
  const base = modifiers.reduce((value, mod) => mod.operation === 0 ? value + mod.amount : value, attribute.value)
  const scaled = modifiers.reduce((value, mod) => mod.operation === 1 ? value + base * mod.amount : value, base)
  const total = modifiers.reduce((value, mod) => mod.operation === 2 ? value * (1 + mod.amount) : value, scaled)
  return Math.max(0, Math.min(64, total))
}

function rootVehicle (entity) {
  if (!entity.vehicle) return entity
  const seen = new Set()
  while (entity.vehicle && !seen.has(entity.vehicle)) {
    seen.add(entity)
    entity = entity.vehicle
  }
  return entity
}

// Java AABB.clip tests only entry faces and excludes both ray endpoints.
function clipEntry (point, delta, min, max, nearest = 1) {
  const epsilon = 1e-7
  let result = null
  for (let i = 0; i < 3; i++) {
    if (Math.abs(delta[i]) <= epsilon) continue
    const t = ((delta[i] > 0 ? min[i] : max[i]) - point[i]) / delta[i]
    if (t <= 0 || t >= nearest) continue
    if (!point.every((value, axis) => axis === i ||
      (min[axis] - epsilon < value + t * delta[axis] && value + t * delta[axis] < max[axis] + epsilon))) continue
    result = nearest = t
  }
  return result
}

module.exports = (bot) => {
  function getEntityDimensions (entity) {
    let width = Number(entity.width)
    let height = Number(entity.height)

    // Interaction entities receive their hitbox dimensions through metadata.
    // minecraft-data cannot describe those dimensions because they are dynamic.
    if (entity.name === 'interaction') {
      const metadata = entity.metadata || {}
      const metadataWidth = Number(metadata[8])
      const metadataHeight = Number(metadata[9])
      if (metadataWidth > 0) width = metadataWidth
      if (metadataHeight > 0) height = metadataHeight
    }

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
    return { width, height }
  }

  function canTargetEntity (entity, includeObjects) {
    if (!entity.position || entity === bot.entity) return false
    if (bot.username && entity.username === bot.username) return false
    return entity.type !== 'object' || (includeObjects && ATTACKABLE_OBJECTS.has(entity.name))
  }

  function intersectEntity (origin, direction, maxDistance, entity, attackDimensions, projectile) {
    const dimensions = attackDimensions ?? getEntityDimensions(entity)
    if (!dimensions || !entity.position) return null

    const radius = attackDimensions ? (projectile ? 1 : 0) : ENTITY_PICK_RADIUS
    const halfWidth = dimensions.width / 2 + radius
    const min = [
      entity.position.x - halfWidth,
      entity.position.y - radius,
      entity.position.z - halfWidth
    ]
    const max = [
      entity.position.x + halfWidth,
      entity.position.y + dimensions.height + radius,
      entity.position.z + halfWidth
    ]
    const point = [origin.x, origin.y, origin.z]
    const directionValues = [direction.x, direction.y, direction.z]
    if (attackDimensions) {
      if (point.every((value, axis) => value >= min[axis] && value < max[axis])) return { distance: 0, inside: true }
      const t = clipEntry(point, directionValues.map(value => value * maxDistance), min, max)
      return t === null ? null : { distance: t * maxDistance, inside: false }
    }

    let near = 0
    let far = maxDistance

    for (let i = 0; i < 3; i++) {
      if (directionValues[i] === 0) {
        if (point[i] < min[i] || point[i] > max[i]) return null
        continue
      }

      let nearAxis = (min[i] - point[i]) / directionValues[i]
      let farAxis = (max[i] - point[i]) / directionValues[i]
      if (nearAxis > farAxis) [nearAxis, farAxis] = [farAxis, nearAxis]
      near = Math.max(near, nearAxis)
      far = Math.min(far, farAxis)
      if (near > far) return null
    }

    if (far < 0 || near > maxDistance) return null
    return { distance: Math.max(0, near) }
  }

  function getViewDirection (pitch, yaw) {
    const csPitch = Math.cos(pitch)
    const snPitch = Math.sin(pitch)
    const csYaw = Math.cos(yaw)
    const snYaw = Math.sin(yaw)
    return new Vec3(-snYaw * csPitch, snPitch, -csYaw * csPitch)
  }

  bot.blockInSight = (maxSteps = 256, vectorLength = 5 / 16) => {
    const block = bot.blockAtCursor(maxSteps * vectorLength)
    if (block) return block
  }

  bot.blockAtCursor = (maxDistance = 256, matcher = null) => {
    return bot.blockAtEntityCursor(bot.entity, maxDistance, matcher)
  }

  bot.entityAtCursor = (maxDistance = 3.5, includeObjects = false, ignoreBlocks = false) => {
    const eyeHeight = bot.entity.eyeHeight ?? bot.entity.height
    if (!bot.entity.position || eyeHeight == null || bot.entity.pitch == null || bot.entity.yaw == null) return null
    const eyePosition = bot.entity.position.offset(0, eyeHeight, 0)
    if (!ignoreBlocks) {
      const block = bot.blockAtCursor(maxDistance)
      maxDistance = block?.intersect.distanceTo(eyePosition) ?? maxDistance
    }

    const entities = Object.values(bot.entities)
      .filter(entity => canTargetEntity(entity, includeObjects))

    const dir = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch), -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch))
    const direction = dir.normalize()

    let targetEntity = null
    let targetDist = maxDistance

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i]
      const intersect = intersectEntity(eyePosition, direction, maxDistance, entity)
      if (intersect) {
        if (intersect.distance < targetDist) {
          targetEntity = entity
          targetDist = intersect.distance
        }
      }
    }

    return targetEntity
  }

  bot.attackEntityAtCursor = (reach, ignoreBlocks = false) => {
    const camera = bot.entity
    const eyeHeight = camera?.eyeHeight ?? camera?.height
    if (!camera?.position || eyeHeight == null || camera.pitch == null || camera.yaw == null || bot.game?.gameMode === 'spectator') return null

    const creative = bot.game?.gameMode === 'creative'
    const entityRange = reach ?? interactionRange(camera, 'entity_interaction_range', creative ? 5 : 3)
    if (!Number.isFinite(entityRange) || entityRange <= 0) return null
    const blockRange = interactionRange(camera, 'block_interaction_range', creative ? 5 : 4.5)
    const origin = camera.position.offset(0, eyeHeight, 0)
    const direction = getViewDirection(camera.pitch, camera.yaw).normalize()
    let limit = ignoreBlocks ? entityRange : Math.max(blockRange, entityRange)
    if (!ignoreBlocks) {
      const ray = direction.scaled(limit)
      const delta = [ray.x, ray.y, ray.z]
      const probe = origin.plus(ray.scaled(0.001))
      const block = bot.world.raycast(origin, direction, limit, block => {
        const shapes = block.interactionShapes ?? block.shapes
        // VoxelShape.clip probes slightly ahead of the eye when starting inside.
        const { x, y, z } = probe.minus(block.position)
        if (shapes.some(s => x >= s[0] && y >= s[1] && z >= s[2] && x < s[3] && y < s[4] && z < s[5])) {
          block.intersect = probe
          return true
        }
        const p = origin.minus(block.position)
        const point = [p.x, p.y, p.z]
        let nearest = 1
        for (const shape of shapes) {
          nearest = clipEntry(point, delta, shape.slice(0, 3), shape.slice(3), nearest) ?? nearest
        }
        if (nearest === 1) return false
        block.intersect = origin.plus(ray.scaled(nearest))
        return true
      })
      if (block) limit = Math.min(limit, block.intersect.distanceTo(origin))
    }

    const vehicle = rootVehicle(camera)
    let target = null
    let distance = limit
    let nearest = limit
    for (const entity of Object.values(bot.entities)) {
      if (entity === camera || !entity.position || entity.isValid === false || bot.entities[entity.id] !== entity) continue
      const { name, type, metadata } = entity
      const projectile = PICKABLE_PROJECTILES.has(name)
      const pickable = LIVING_TYPES.has(type) || projectile || PICKABLE_NON_LIVING.has(name) ||
        /(?:^|_)(?:boat|raft|minecart)$/.test(name)
      // The dragon body is not pickable; vanilla exposes separate dragon parts.
      if (!pickable || name === 'ender_dragon' || (type === 'player' && bot.players?.[entity.username]?.gamemode === 3)) continue

      let dimensions = getEntityDimensions(entity)
      if (name === 'armor_stand') {
        // Entity (8) + LivingEntity (7) metadata entries precede DATA_CLIENT_FLAGS in 26.3.
        const keys = bot.registry?.entitiesByName?.[name]?.metadataKeys
        const index = keys?.indexOf('client_flags') ?? -1
        const flags = metadata?.[index >= 0 ? index : 15]
        if (flags & 0x10) continue
        if (dimensions && (flags & 1)) dimensions = { width: dimensions.width / 2, height: dimensions.height / 2 }
      } else if (name === 'interaction') {
        dimensions = { width: metadata?.[8] ?? 1, height: metadata?.[9] ?? 1 }
        if (dimensions.width <= 0 || dimensions.height <= 0) continue
      }

      if (!dimensions) continue
      const hit = intersectEntity(origin, direction, limit, entity, dimensions, projectile)
      if (!hit) continue
      // Match ProjectileUtil's zero-distance and shared-root-vehicle handling.
      const sharesVehicle = rootVehicle(entity) === vehicle
      if (hit.inside || ((hit.distance < nearest || nearest === 0) &&
        (!sharesVehicle || nearest === 0))) {
        target = entity
        distance = hit.distance
        if (hit.inside || !sharesVehicle) nearest = hit.distance
      }
    }
    return distance < limit && distance < entityRange ? target : null
  }

  bot.blockAtEntityCursor = (entity = bot.entity, maxDistance = 256, matcher = null) => {
    if (!entity.position || entity.pitch == null || entity.yaw == null) return null
    const { position, pitch, yaw } = entity
    const eyeHeight = entity.eyeHeight ?? entity.height
    if (eyeHeight == null) return null

    const eyePosition = position.offset(0, eyeHeight, 0)
    const viewDirection = getViewDirection(pitch, yaw)

    return bot.world.raycast(eyePosition, viewDirection, maxDistance, matcher)
  }
}
