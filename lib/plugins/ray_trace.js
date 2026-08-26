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

  function intersectEntity (origin, direction, maxDistance, entity) {
    const dimensions = getEntityDimensions(entity)
    if (!dimensions || !entity.position) return null

    const radius = ENTITY_PICK_RADIUS
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
