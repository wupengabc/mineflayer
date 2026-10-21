// Vanilla 26.2/26.3: TypedDataComponent.encodeValue(RegistryOps<HashCode>)
// uses the persistent Codec, then HashOps.CRC32C_INSTANCE, NOT the stream codec.
const crcTable = Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ ((byte & 1) ? 0x82f63b78 : 0)
  return byte >>> 0
})

function crc32c (bytes) {
  let crc = -1
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return (crc ^ -1) >>> 0
}

function hashBytes (tag, bytes) {
  return crc32c(Buffer.concat([Buffer.from([tag]), bytes]))
}

function exactLong (value) {
  if (Array.isArray(value) && value.length === 2 &&
      Number.isInteger(value[0]) && value[0] >= -0x80000000 && value[0] <= 0x7fffffff &&
      Number.isInteger(value[1]) && value[1] >= -0x80000000 && value[1] <= 0xffffffff) {
    return BigInt.asIntN(64, (BigInt(value[0]) << 32n) | BigInt(value[1] >>> 0))
  }
  if (typeof value === 'bigint') return BigInt.asIntN(64, value)
  if (Number.isSafeInteger(value)) return BigInt(value)
  throw new Error('Expected an exact NBT long')
}

function numberHash (type, value) {
  const formats = {
    byte: [6, 1, 'writeInt8'],
    short: [7, 2, 'writeInt16LE'],
    int: [8, 4, 'writeInt32LE'],
    long: [9, 8, 'writeBigInt64LE'],
    float: [10, 4, 'writeFloatLE'],
    double: [11, 8, 'writeDoubleLE']
  }
  const [tag, size, method] = formats[type]
  const bytes = Buffer.alloc(size)
  if (type === 'long') {
    value = exactLong(value)
  } else if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected a finite ${type}`)
  } else if (['byte', 'short', 'int'].includes(type) && !Number.isInteger(value)) {
    throw new Error(`Expected an integer ${type}`)
  }
  bytes[method](value)
  return hashBytes(tag, bytes)
}

function stringHash (value) {
  if (typeof value !== 'string') throw new Error('Expected a string')
  // Guava PrimitiveSink.putUnencodedChars writes UTF-16 code units, little endian.
  const bytes = Buffer.alloc(4 + value.length * 2)
  bytes.writeInt32LE(value.length)
  for (let i = 0; i < value.length; i++) bytes.writeUInt16LE(value.charCodeAt(i), 4 + i * 2)
  return hashBytes(12, bytes)
}

function booleanHash (value) {
  if (typeof value !== 'boolean') throw new Error('Expected a boolean')
  return crc32c(Buffer.from([13, value ? 1 : 0]))
}

function sequenceHash (start, end, hashes) {
  const bytes = Buffer.alloc(2 + hashes.length * 4)
  bytes[0] = start
  hashes.forEach((hash, i) => bytes.writeUInt32LE(hash, 1 + i * 4))
  bytes[bytes.length - 1] = end
  return crc32c(bytes)
}

function mapHash (entries) {
  // CRC32C HashCode.padToLong is unsigned; compare key hash, then value hash.
  entries.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  return sequenceHash(2, 3, entries.flat())
}

function recordHash (fields) {
  return mapHash(fields.map(([key, hash]) => [stringHash(key), hash]))
}

function nbtHash ({ type, value }) {
  if (type === 'end') return crc32c(Buffer.from([1]))
  if (['byte', 'short', 'int', 'long', 'float', 'double'].includes(type)) return numberHash(type, value)
  if (type === 'string') return stringHash(value)
  if (type === 'compound') return recordHash(Object.entries(value).map(([key, tag]) => [key, nbtHash(tag)]))
  if (type === 'list') {
    return sequenceHash(4, 5, value.value.map(entry => nbtHash({ type: value.type, value: entry })))
  }
  if (type === 'byteArray' || type === 'intArray' || type === 'longArray') {
    const size = type === 'byteArray' ? 1 : type === 'intArray' ? 4 : 8
    const start = type === 'byteArray' ? 14 : type === 'intArray' ? 16 : 18
    const bytes = Buffer.alloc(2 + value.length * size)
    bytes[0] = start
    value.forEach((entry, i) => {
      if (size === 1) {
        if (!Number.isInteger(entry) || entry < -128 || entry > 255) throw new Error('Invalid NBT byte array')
        bytes[1 + i] = entry
      } else if (size === 4) {
        if (!Number.isInteger(entry)) throw new Error('Invalid NBT int array')
        bytes.writeInt32LE(entry, 1 + i * size)
      } else {
        bytes.writeBigInt64LE(exactLong(entry), 1 + i * size)
      }
    })
    bytes[bytes.length - 1] = start + 1
    return crc32c(bytes)
  }
  throw new Error(`Unsupported NBT tag ${type}`)
}

function identifier (value) {
  if (typeof value !== 'string' || !/^(?:[a-z0-9_.-]+:)?[a-z0-9/._-]+$/.test(value)) throw new Error('Invalid resource identifier')
  return value.includes(':') ? value : `minecraft:${value}`
}

function textHash (tag, appended = []) {
  const list = value => {
    if (value?.type !== 'list') throw new Error('Expected a component list')
    return value.value.value.map(entry => ({ type: value.value.type, value: entry }))
  }
  if (tag?.type === 'list') {
    const entries = list(tag)
    if (!entries.length) throw new Error('Component lists must be nonempty')
    // ComponentSerialization.createFromList copies the first element, then
    // appends the remaining elements after its existing siblings.
    return textHash(entries[0], [...entries.slice(1), ...appended])
  }
  if (!['string', 'compound'].includes(tag?.type)) throw new Error('Unsupported text component tag')
  const data = tag.type === 'string' ? { text: tag } : tag.value
  const fields = []
  const string = value => {
    if (value?.type !== 'string') throw new Error('Expected a text string')
    return value.value
  }
  const kind = data.type ? string(data.type) : ['text', 'translate', 'keybind'].find(name => data[name] != null)
  const allowed = new Set(['type', 'extra', 'color', 'shadow_color', 'bold', 'italic', 'underlined', 'strikethrough', 'obfuscated', 'insertion', 'font'])
  let plain
  if (kind === 'text') {
    allowed.add('text')
    plain = string(data.text)
    fields.push(['text', stringHash(plain)])
  } else if ((kind === 'translate' && data.type == null) || kind === 'translatable') {
    for (const key of ['translate', 'fallback', 'with']) allowed.add(key)
    fields.push(['translate', stringHash(string(data.translate))])
    if (data.fallback?.type === 'string') fields.push(['fallback', stringHash(data.fallback.value)])
    if (data.with != null) {
      const args = list(data.with)
      if (args.length) {
        fields.push(['with', sequenceHash(4, 5, args.map(arg => {
          if (['byte', 'short', 'int', 'long', 'float', 'double'].includes(arg.type)) {
            // ExtraCodecs.JAVA preserves the NbtOps numeric type of arguments.
            return numberHash(arg.type, arg.value)
          }
          return textHash(arg)
        }))])
      }
    }
  } else if (kind === 'keybind') {
    allowed.add('keybind')
    fields.push(['keybind', stringHash(string(data.keybind))])
  } else {
    throw new Error(`Unsupported text content ${kind}`)
  }
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) throw new Error(`Unsupported text field ${key}`)
  }
  for (const key of ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated']) {
    if (data[key] == null) continue
    if (data[key].type !== 'byte') throw new Error(`Invalid text style ${key}`)
    fields.push([key, booleanHash(data[key].value !== 0)])
  }
  if (data.color != null) {
    let color = string(data.color)
    if (/^#[0-9a-fA-F]{1,6}$/.test(color)) color = `#${Number.parseInt(color.slice(1), 16).toString(16).toUpperCase().padStart(6, '0')}`
    else if (!['black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray', 'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple', 'yellow', 'white'].includes(color)) throw new Error('Invalid text color')
    fields.push(['color', stringHash(color)])
  }
  if (data.shadow_color != null) {
    if (data.shadow_color.type !== 'int') throw new Error('Unsupported shadow color representation')
    fields.push(['shadow_color', numberHash('int', data.shadow_color.value)])
  }
  if (data.insertion != null) fields.push(['insertion', stringHash(string(data.insertion))])
  if (data.font != null) fields.push(['font', stringHash(identifier(string(data.font)))])
  const siblings = data.extra == null ? [] : list(data.extra)
  if (data.extra != null && !siblings.length) throw new Error('Component extra must be nonempty')
  siblings.push(...appended)
  if (siblings.length) fields.push(['extra', sequenceHash(4, 5, siblings.map(entry => textHash(entry)))])
  return plain != null && fields.length === 1 ? stringHash(plain) : recordHash(fields)
}

function resolvableHash (value, numberType) {
  if (value?.isConstant === true) return numberHash(numberType, value.value)
  if (value?.isConstant === false) return stringHash(identifier(value.value))
  throw new Error(`Invalid resolvable ${numberType}`)
}

module.exports = function createItemHasher (registry) {
  const mappings = registry.protocol.types.SlotComponentType[1].mappings
  const types = new Set(Object.values(mappings))
  const componentName = type => {
    const name = typeof type === 'number' ? mappings[type] : type?.replace(/^minecraft:/, '')
    if (!types.has(name)) throw new Error(`Unknown data component ${type}`)
    return name
  }

  function templateHash (template) {
    const { itemId, itemCount, components, removeComponents } = template
    if (!Number.isInteger(itemId) || itemId <= 0 || !registry.items[itemId]) throw new Error('Invalid template item ID')
    if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > 99) throw new Error('Invalid template item count')
    if (!Array.isArray(components) || !Array.isArray(removeComponents)) throw new Error('Missing template component patch')
    const receivedItems = registry.registries?.['minecraft:item']?.entries
    const itemName = receivedItems ? receivedItems[itemId]?.key : registry.items[itemId].name
    const fields = [['id', stringHash(identifier(itemName))]]
    if (itemCount !== 1) fields.push(['count', numberHash('int', itemCount)])
    if (components.length || removeComponents.length) {
      const patch = new Map()
      const transient = new Set(['creative_slot_lock', 'additional_trade_cost', 'map_post_processing'])
      for (const component of components) {
        const name = componentName(component.type)
        if (!transient.has(name)) patch.set(identifier(name), componentHash(name, component.data))
      }
      for (const component of removeComponents) {
        const name = componentName(component.type)
        if (!transient.has(name)) {
          patch.delete(identifier(name))
          patch.set(`!${identifier(name)}`, mapHash([]))
        }
      }
      fields.push(['components', recordHash([...patch])])
    }
    return recordHash(fields)
  }

  function componentHash (type, data) {
    switch (type) {
      case 'max_stack_size': case 'max_damage': case 'damage': case 'repair_cost':
      case 'map_id': case 'ominous_bottle_amplifier': case 'dyed_color': case 'map_color':
        return numberHash('int', data)
      case 'minimum_attack_charge': case 'potion_duration_scale':
        return numberHash('float', data)
      case 'enchantment_glint_override':
        return booleanHash(data)
      case 'unbreakable': case 'intangible_projectile': case 'glider': case 'waxed':
        return mapHash([]) // Unit.CODEC = MapCodec.unitCodec
      case 'item_model': case 'tooltip_style': case 'note_block_sound':
        return stringHash(identifier(data))
      case 'rarity':
        if (!['common', 'uncommon', 'rare', 'epic'].includes(data)) throw new Error('Invalid rarity')
        return stringHash(data)
      case 'dye': case 'base_color': case 'wolf/collar': case 'cat/collar':
      case 'sheep/color': case 'shulker/color': case 'cushion/color':
      case 'tropical_fish/base_color': case 'tropical_fish/pattern_color': {
        const colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
        const color = typeof data === 'number' ? colors[data] : data
        if (!colors.includes(color)) throw new Error('Invalid dye color')
        return stringHash(color)
      }
      case 'enchantments': case 'stored_enchantments': {
        // Network IDs belong to the received registry, not the static data file.
        const entries = registry.registries?.['minecraft:enchantment']?.entries
        const levels = new Map()
        for (const { id, level } of data.enchantments) {
          if (!Number.isInteger(id) || id < 0 || !entries?.[id]) throw new Error('Missing received enchantment registry entry')
          if (!Number.isInteger(level) || level < 1 || level > 255) throw new Error('Invalid enchantment level')
          levels.set(identifier(entries[id].key), level)
        }
        return recordHash([...levels].map(([key, level]) => [key, numberHash('int', level)]))
      }
      case 'provides_pottery_pattern': {
        const entries = registry.registries?.['minecraft:decorated_pot_pattern']?.entries
        if (!Number.isInteger(data) || data < 0 || !entries?.[data]?.key) {
          throw new Error('Missing received decorated pot pattern registry entry')
        }
        return stringHash(identifier(entries[data].key))
      }
      case 'swing_animation': case 'attack_animation': case 'interact_animation': {
        if (!['none', 'whack', 'stab'].includes(data.type)) throw new Error('Invalid swing animation type')
        const minimum = registry.version.version >= 777 ? 0 : 1
        if (!Number.isInteger(data.duration) || data.duration < minimum) throw new Error('Invalid swing animation duration')
        const fields = []
        if (data.type !== 'whack') fields.push(['type', stringHash(data.type)])
        if (data.duration !== 6) fields.push(['duration', numberHash('int', data.duration)])
        return recordHash(fields)
      }
      case 'villager_food':
        if (!Number.isInteger(data.nutrition) || data.nutrition <= 0) throw new Error('Invalid villager food nutrition')
        return recordHash([['nutrition', numberHash('int', data.nutrition)]])
      case 'compostable':
        return recordHash([['layers', resolvableHash(data.layers, 'int')]])
      case 'cooking_fuel':
        return recordHash([
          ['burn_time', resolvableHash(data.burnTime, 'int')],
          ['speed_multiplier', resolvableHash(data.speedMultiplier, 'float')]
        ])
      case 'brewing_fuel':
        return recordHash([
          ['uses', resolvableHash(data.uses, 'int')],
          ['speed_multiplier', resolvableHash(data.speedMultiplier, 'float')]
        ])
      case 'firework_explosion': {
        if (!['small_ball', 'large_ball', 'star', 'creeper', 'burst'].includes(data.shape)) throw new Error('Invalid firework shape')
        const fields = [['shape', stringHash(data.shape)]]
        for (const [name, key] of [['colors', 'colors'], ['fadeColors', 'fade_colors']]) {
          if (!Array.isArray(data[name])) throw new Error(`Invalid firework ${name}`)
          if (data[name].length) fields.push([key, sequenceHash(4, 5, data[name].map(color => numberHash('int', color)))])
        }
        if (data.hasTrail !== false) fields.push(['has_trail', booleanHash(data.hasTrail)])
        if (data.hasTwinkle !== false) fields.push(['has_twinkle', booleanHash(data.hasTwinkle)])
        return recordHash(fields)
      }
      case 'fireworks': {
        if (!Number.isInteger(data.flightDuration) || data.flightDuration < 0 || data.flightDuration > 255) throw new Error('Invalid firework flight duration')
        if (!Array.isArray(data.explosions) || data.explosions.length > 256) throw new Error('Fireworks exceed 256 explosions')
        const fields = []
        // ExtraCodecs.UNSIGNED_BYTE encodes Integer.byteValue(), including 255=-1.
        if (data.flightDuration !== 0) fields.push(['flight_duration', numberHash('byte', (data.flightDuration << 24) >> 24)])
        if (data.explosions.length) fields.push(['explosions', sequenceHash(4, 5, data.explosions.map(explosion => componentHash('firework_explosion', explosion)))])
        return recordHash(fields)
      }
      case 'use_remainder':
        return templateHash(data)
      case 'sulfur_cube_content':
        return templateHash(data.absorbedBlockItemStack)
      case 'charged_projectiles':
        if (data.projectiles.length > 1024) throw new Error('Charged projectiles exceed 1024 entries')
        return sequenceHash(4, 5, data.projectiles.map(templateHash))
      case 'bundle_contents':
        return sequenceHash(4, 5, data.contents.map(templateHash))
      case 'writable_book_content': {
        if (data.pages.length > 100) throw new Error('Writable book exceeds 100 pages')
        if (!data.pages.length) return mapHash([])
        const textHash = value => {
          if (typeof value !== 'string' || value.length > 1024) throw new Error('Writable book page exceeds 1024 characters')
          return stringHash(value)
        }
        const pages = data.pages.map(page => {
          const fields = [['raw', textHash(page.content)]]
          if (page.filteredContent != null) fields.push(['filtered', textHash(page.filteredContent)])
          return recordHash(fields)
        })
        return recordHash([['pages', sequenceHash(4, 5, pages)]])
      }
      case 'written_book_content': {
        const titleHash = value => {
          if (typeof value !== 'string' || value.length > 32) throw new Error('Written book title exceeds 32 characters')
          return stringHash(value)
        }
        const title = [['raw', titleHash(data.rawTitle)]]
        if (data.filteredTitle != null) title.push(['filtered', titleHash(data.filteredTitle)])
        const fields = [['title', recordHash(title)], ['author', stringHash(data.author)]]
        if (!Number.isInteger(data.generation) || data.generation < 0 || data.generation > 3) throw new Error('Invalid written book generation')
        if (data.generation !== 0) fields.push(['generation', numberHash('int', data.generation)])
        if (data.pages.length) {
          fields.push(['pages', sequenceHash(4, 5, data.pages.map(page => {
            const values = [['raw', textHash(page.content)]]
            if (page.filteredContent != null) values.push(['filtered', textHash(page.filteredContent)])
            return recordHash(values)
          }))])
        }
        if (data.resolved !== false) fields.push(['resolved', booleanHash(data.resolved)])
        return recordHash(fields)
      }
      case 'container': {
        if (data.contents.length > 256) throw new Error('Container exceeds 256 slots')
        const slots = []
        data.contents.forEach((item, slot) => {
          if (item != null) slots.push(recordHash([['slot', numberHash('int', slot)], ['item', templateHash(item)]]))
        })
        return sequenceHash(4, 5, slots)
      }
      case 'custom_data': case 'bucket_entity_data':
        if (data?.type !== 'compound') throw new Error('CustomData requires typed compound NBT')
        return nbtHash(data)
      case 'custom_name': case 'item_name':
        return textHash(data)
      case 'lore':
        if (data.length > 256) throw new Error('Lore exceeds 256 lines')
        return sequenceHash(4, 5, data.map(line => componentHash('custom_name', line)))
      case 'enchantable':
        return recordHash([['value', numberHash('int', data)]])
      case 'use_effects': {
        const fields = []
        if (data.can_sprint !== false) fields.push(['can_sprint', booleanHash(data.can_sprint)])
        if (data.interact_vibrations !== true) fields.push(['interact_vibrations', booleanHash(data.interact_vibrations)])
        if (Math.fround(data.speed_multiplier) !== Math.fround(0.2)) fields.push(['speed_multiplier', numberHash('float', data.speed_multiplier)])
        return recordHash(fields)
      }
      case 'custom_model_data': {
        const fields = []
        for (const [name, hash] of [['floats', value => numberHash('float', value)], ['flags', booleanHash], ['strings', stringHash], ['colors', value => numberHash('int', value)]]) {
          if (!Array.isArray(data[name])) throw new Error(`Invalid custom model ${name}`)
          if (data[name].length) fields.push([name, sequenceHash(4, 5, data[name].map(hash))])
        }
        return recordHash(fields)
      }
      case 'attack_range': {
        const fields = []
        for (const [name, key, fallback, maximum] of [
          ['minRange', 'min_reach', 0, 64], ['maxRange', 'max_reach', 3, 64],
          ['minCreativeRange', 'min_creative_reach', 0, 64], ['maxCreativeRange', 'max_creative_reach', 5, 64],
          ['hitboxMargin', 'hitbox_margin', 0.3, 1], ['mobFactor', 'mob_factor', 1, 2]
        ]) {
          const value = Math.fround(data[name])
          if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`Invalid attack range ${name}`)
          if (!Object.is(value, Math.fround(fallback))) fields.push([key, numberHash('float', value)])
        }
        return recordHash(fields)
      }
      case 'food': {
        const fields = [['nutrition', numberHash('int', data.nutrition)], ['saturation', numberHash('float', data.saturationModifier)]]
        if (data.canAlwaysEat !== false) fields.push(['can_always_eat', booleanHash(data.canAlwaysEat)])
        return recordHash(fields)
      }
      case 'weapon': {
        const fields = []
        if (data.itemDamagePerAttack !== 1) fields.push(['item_damage_per_attack', numberHash('int', data.itemDamagePerAttack)])
        if (!Object.is(Math.fround(data.disableBlockingForSeconds), 0)) fields.push(['disable_blocking_for_seconds', numberHash('float', data.disableBlockingForSeconds)])
        return recordHash(fields)
      }
      case 'use_cooldown': {
        const fields = [['seconds', numberHash('float', data.seconds)]]
        if (data.cooldownGroup != null) fields.push(['cooldown_group', stringHash(identifier(data.cooldownGroup))])
        return recordHash(fields)
      }
      case 'tooltip_display': {
        const fields = []
        if (data.hideTooltip !== false) fields.push(['hide_tooltip', booleanHash(data.hideTooltip)])
        if (data.hiddenComponents.length) fields.push(['hidden_components', sequenceHash(4, 5, [...new Set(data.hiddenComponents.map(componentName))].map(name => stringHash(identifier(name))))])
        return recordHash(fields)
      }
      case 'block_state':
        return recordHash([...new Map(data.properties.map(({ name, value }) => [name, value]))].map(([name, value]) => [name, stringHash(value)]))
      default:
        throw new Error('Persistent component Codec is not implemented')
    }
  }

  return function toHashedSlot (item) {
    if (item == null || item.count <= 0 || item.type === 0) return null
    if (!Number.isInteger(item.type) || item.type < 0 || item.type > 0x7fffffff || !Number.isInteger(item.count) || item.count > 0x7fffffff) throw new Error('Invalid hashed item id/count')
    if (item.nbt && Object.keys(item.nbt.value ?? {}).length) throw new Error('Cannot hash legacy item NBT as a modern component patch')
    if (!Array.isArray(item.components) || !Array.isArray(item.removedComponents)) throw new Error('Missing modern item component patch')
    const added = new Set()
    const components = item.components.map(component => {
      const type = componentName(component.type)
      if (added.has(type)) throw new Error(`Duplicate data component ${type}`)
      added.add(type)
      try {
        return { type, hash: componentHash(type, component.data) | 0 }
      } catch (error) {
        throw new Error(`Cannot hash item component ${type}: ${error.message}`)
      }
    })
    const removed = new Set(item.removedComponents.map(component => componentName(component.type)))
    if (components.length > 256 || removed.size > 256) throw new Error('Hashed component patch exceeds 256 entries')
    if ([...removed].some(type => added.has(type))) throw new Error('Component patch both adds and removes the same type')
    return { itemId: item.type, itemCount: item.count, components, removeComponents: [...removed].map(type => ({ type })) }
  }
}
