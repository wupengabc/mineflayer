const { Vec3 } = require('vec3')
const { RaycastIterator } = require('prismarine-world').iterators

module.exports = (bot) => {
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

  bot.entityAtCursor = (maxDistance = 3.5) => {
    const block = bot.blockAtCursor(maxDistance)
    const eyePosition = bot.entity.position.offset(0, bot.entity.eyeHeight ?? bot.entity.height, 0)
    maxDistance = block?.intersect.distanceTo(eyePosition) ?? maxDistance

    const entities = Object.values(bot.entities)
      .filter(entity => entity.type !== 'object' && entity.username !== bot.username)

    const dir = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch), -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch))
    const iterator = new RaycastIterator(bot.entity.position.offset(0, bot.entity.eyeHeight, 0), dir.normalize(), maxDistance)

    let targetEntity = null
    let targetDist = maxDistance

    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i]
      const w = entity.width / 2

      const shapes = [[-w, 0, -w, w, entity.height, w]]
      const intersect = iterator.intersect(shapes, entity.position)
      if (intersect) {
        const hitDir = intersect.pos.minus(eyePosition)
        if (hitDir.dot(dir) >= 0) {
          const dist = eyePosition.distanceTo(intersect.pos)
          if (dist < targetDist) {
            targetEntity = entity
            targetDist = dist
          }
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
