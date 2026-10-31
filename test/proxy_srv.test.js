/* eslint-env mocha */

const assert = require('assert')
const dns = require('dns')
const { once } = require('events')
const { Duplex } = require('stream')
const proxy = require('../lib/proxy')
const { createBot } = require('..')
const { createDeserializer } = require('minecraft-protocol/src/transforms/serializer')
const [readVarInt] = require('protodef').types.varint

describe('proxy SRV destinations', () => {
  let resolveSrv
  let createProxyConnector
  let bot
  let socket
  let destinations
  let queries
  let writes

  beforeEach(() => {
    resolveSrv = dns.resolveSrv
    createProxyConnector = proxy.createProxyConnector
    destinations = []
    queries = []
    writes = []
    proxy.createProxyConnector = () => (host, port) => {
      destinations.push({ host, port })
      socket = new Duplex({
        read () {},
        write (buffer, encoding, callback) {
          writes.push(Buffer.from(buffer))
          callback()
        }
      })
      socket.setNoDelay = () => {}
      process.nextTick(() => socket.emit('connect'))
      return socket
    }
  })

  afterEach(() => {
    dns.resolveSrv = resolveSrv
    proxy.createProxyConnector = createProxyConnector
    if (bot) bot.end()
    if (socket) socket.destroy()
    bot = socket = undefined
  })

  async function connect (options = {}) {
    bot = createBot({
      username: 'ProxySrvTest',
      host: 'play.example.test',
      auth: 'offline',
      version: '1.21.4',
      autoConnect: false,
      loadInternalPlugins: false,
      logErrors: false,
      proxy: { type: 'http', host: 'proxy.example.test', port: 8080 },
      ...options
    })
    const connected = once(bot, 'connect')
    bot.connect()
    await connected
  }

  it('uses the SRV tunnel endpoint and preserves the original handshake address', async () => {
    dns.resolveSrv = (name, callback) => {
      queries.push(name)
      process.nextTick(() => callback(null, [{ name: 'backend.example.test', port: 25580 }]))
    }
    await connect()
    assert.deepStrictEqual(queries, ['_minecraft._tcp.play.example.test'])
    assert.deepStrictEqual(destinations, [{ host: 'backend.example.test', port: 25580 }])
    const wire = Buffer.concat(writes)
    const length = readVarInt(wire, 0)
    const parser = createDeserializer({ isServer: true, version: '1.21.4', state: 'handshaking' })
    const handshake = parser.parsePacketBuffer(wire.subarray(length.size, length.size + length.value)).data
    assert.strictEqual(handshake.name, 'set_protocol')
    assert.strictEqual(handshake.params.serverHost, 'play.example.test')
    assert.strictEqual(handshake.params.serverPort, 25565)
  })

  for (const result of ['error', 'empty']) {
    it(`falls back to the requested endpoint on an ${result} SRV result`, async () => {
      dns.resolveSrv = (name, callback) => {
        process.nextTick(() => callback(result === 'error' ? new Error('ENODATA') : null, []))
      }
      await connect()
      assert.deepStrictEqual(destinations, [{ host: 'play.example.test', port: 25565 }])
    })
  }

  for (const options of [
    { host: 'play.example.test', port: 25590 },
    { host: '127.0.0.1' },
    { host: '::1' },
    { host: 'localhost' }
  ]) {
    it(`skips SRV for ${options.host}:${options.port || 25565}`, async () => {
      dns.resolveSrv = () => assert.fail('SRV lookup must be skipped')
      await connect(options)
      assert.deepStrictEqual(destinations, [{ host: options.host, port: options.port || 25565 }])
    })
  }
})
