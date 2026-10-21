const assert = require('assert')
const { Client, createDeserializer } = require('minecraft-protocol')
const [readVarInt] = require('protodef').types.varint

function createClient () {
  const client = new Client(false, '26.2', undefined, true)
  const parser = createDeserializer({ state: 'play', version: '26.2', isServer: true })
  const writes = []
  client.state = 'play'
  client.ended = false
  client.socket = {
    writable: true,
    writableNeedDrain: false,
    write (buffer) {
      const length = readVarInt(buffer, 0)
      assert.strictEqual(length.size + length.value, buffer.length)
      const parsed = parser.parsePacketBuffer(buffer.subarray(length.size))
      assert.strictEqual(parsed.metadata.size, length.value)
      writes.push(parsed.data)
      return true
    }
  }
  return { client, writes }
}

module.exports = { createClient }
