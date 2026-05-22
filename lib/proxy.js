// mineflayer proxy support
//
// Lets users tunnel the underlying TCP connection through a SOCKS5 / HTTP /
// HTTPS proxy. Wired in at createBot time by replacing options.connect with a
// custom factory that hands a pre-connected socket to the protocol client.
//
// Configuration shape:
//   proxy: {
//     type: 'socks5' | 'http' | 'https',
//     host: string,
//     port: number,
//     username?: string | null,
//     password?: string | null
//   }
//
// SOCKS auth:
//   - SOCKS5 with username/password uses RFC 1929 user/pass authentication.
//   - SOCKS5 without credentials uses no-auth.
//
// HTTP/HTTPS CONNECT:
//   - Sends a `CONNECT host:port HTTP/1.1` request and reads the status line.
//   - Optional credentials are sent as `Proxy-Authorization: Basic <base64>`.
//   - HTTPS variant performs a TLS handshake to the proxy first, then sends
//     the CONNECT request over the encrypted channel.
//
// Errors are surfaced via the bot's `error` event by emitting on the client
// passed in by createBot.

const net = require('net')
const tls = require('tls')

const SUPPORTED_TYPES = new Set(['socks5', 'sock5', 'socks', 'http', 'https'])

function normalizeType (type) {
  if (typeof type !== 'string') return null
  const t = type.toLowerCase().trim()
  if (t === 'sock5' || t === 'socks' || t === 'socks5') return 'socks5'
  if (t === 'http') return 'http'
  if (t === 'https') return 'https'
  return null
}

function validateProxy (proxy) {
  if (!proxy || typeof proxy !== 'object') {
    throw new Error('proxy must be an object')
  }
  if (!SUPPORTED_TYPES.has(String(proxy.type ?? '').toLowerCase())) {
    throw new Error(`proxy.type must be one of: socks5, http, https (got: ${proxy.type})`)
  }
  if (typeof proxy.host !== 'string' || !proxy.host) {
    throw new Error('proxy.host is required')
  }
  const port = Number(proxy.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('proxy.port must be an integer in [1, 65535]')
  }
  return { type: normalizeType(proxy.type), host: proxy.host, port, username: proxy.username ?? null, password: proxy.password ?? null }
}

// Build a function that produces a connected, ready-to-use socket whose
// remote endpoint is the Minecraft server reached via the configured proxy.
function createProxyConnector (proxy) {
  const cfg = validateProxy(proxy)

  return function connect (host, port) {
    if (cfg.type === 'socks5') return socks5Connect(cfg, host, port)
    if (cfg.type === 'http') return httpConnect(cfg, host, port, false)
    if (cfg.type === 'https') return httpConnect(cfg, host, port, true)
    throw new Error(`unsupported proxy type: ${cfg.type}`)
  }
}

function socks5Connect (cfg, destHost, destPort) {
  let socks
  try {
    socks = require('socks').SocksClient
  } catch (e) {
    const err = new Error("proxy.type 'socks5' requires the 'socks' package. Install it with: npm install socks")
    err.cause = e
    throw err
  }

  // socks.createConnection returns a Promise; we expose a Duplex socket. We
  // use a placeholder PassThrough-like net.Socket and wire it once the socks
  // client connects. To keep the API consistent with `net.connect`, we
  // create a real socket via the socks library and propagate events.
  const socket = new net.Socket()
  socket.pause()

  socks.createConnection({
    proxy: {
      host: cfg.host,
      port: cfg.port,
      type: 5,
      userId: cfg.username || undefined,
      password: cfg.password || undefined
    },
    command: 'connect',
    destination: { host: destHost, port: destPort },
    timeout: 30_000
  }).then(({ socket: tunneled }) => {
    // Hand the underlying tunneled socket to the caller-visible socket by
    // attaching it as the wrapped stream.
    socket.attach = tunneled
    // Re-emit lifecycle events from the tunneled socket so consumers that
    // attach listeners on the outer socket still work.
    tunneled.on('data', (chunk) => socket.emit('data', chunk))
    tunneled.on('end', () => socket.emit('end'))
    tunneled.on('close', (hadError) => socket.emit('close', hadError))
    tunneled.on('error', (err) => socket.emit('error', err))
    socket.write = tunneled.write.bind(tunneled)
    socket.end = tunneled.end.bind(tunneled)
    socket.destroy = tunneled.destroy.bind(tunneled)
    socket.setNoDelay = tunneled.setNoDelay?.bind(tunneled) || (() => {})
    socket.setKeepAlive = tunneled.setKeepAlive?.bind(tunneled) || (() => {})
    socket.setTimeout = tunneled.setTimeout?.bind(tunneled) || (() => {})
    socket.resume()
    socket.emit('connect')
  }).catch((err) => {
    process.nextTick(() => socket.emit('error', err))
  })

  return socket
}

function httpConnect (cfg, destHost, destPort, secure) {
  // Open a raw TCP (or TLS) connection to the proxy, send a CONNECT request,
  // wait for the 2xx response, then expose the tunneled socket.
  const outer = new net.Socket()
  outer.pause()

  const onProxySocket = (proxySocket) => {
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const headerEnd = buf.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      proxySocket.removeListener('data', onData)
      const head = buf.subarray(0, headerEnd).toString('ascii')
      const rest = buf.subarray(headerEnd + 4)
      const statusLine = head.split('\r\n', 1)[0]
      const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d+)/i)
      if (!m || m[1][0] !== '2') {
        proxySocket.destroy()
        outer.emit('error', new Error(`HTTP CONNECT failed: ${statusLine}`))
        return
      }

      // Wire outer to proxySocket (post-handshake bytes already buffered in `rest`).
      proxySocket.on('data', (chunk) => outer.emit('data', chunk))
      proxySocket.on('end', () => outer.emit('end'))
      proxySocket.on('close', (hadError) => outer.emit('close', hadError))
      proxySocket.on('error', (err) => outer.emit('error', err))
      outer.write = proxySocket.write.bind(proxySocket)
      outer.end = proxySocket.end.bind(proxySocket)
      outer.destroy = proxySocket.destroy.bind(proxySocket)
      outer.setNoDelay = proxySocket.setNoDelay?.bind(proxySocket) || (() => {})
      outer.setKeepAlive = proxySocket.setKeepAlive?.bind(proxySocket) || (() => {})
      outer.setTimeout = proxySocket.setTimeout?.bind(proxySocket) || (() => {})
      outer.resume()
      outer.emit('connect')
      if (rest.length > 0) outer.emit('data', rest)
    }
    proxySocket.on('data', onData)
    proxySocket.on('error', (err) => outer.emit('error', err))

    const lines = [`CONNECT ${destHost}:${destPort} HTTP/1.1`, `Host: ${destHost}:${destPort}`]
    if (cfg.username || cfg.password) {
      const creds = `${cfg.username || ''}:${cfg.password || ''}`
      lines.push(`Proxy-Authorization: Basic ${Buffer.from(creds, 'utf8').toString('base64')}`)
    }
    lines.push('Connection: Keep-Alive', 'Proxy-Connection: Keep-Alive', '', '')
    proxySocket.write(lines.join('\r\n'))
  }

  if (secure) {
    const tlsSocket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => onProxySocket(tlsSocket))
    tlsSocket.on('error', (err) => outer.emit('error', err))
  } else {
    const tcp = net.connect(cfg.port, cfg.host, () => onProxySocket(tcp))
    tcp.on('error', (err) => outer.emit('error', err))
  }

  return outer
}

module.exports = {
  createProxyConnector,
  validateProxy
}
