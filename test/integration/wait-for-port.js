#!/usr/bin/env node
'use strict'

// Tiny dependency-free TCP port poller. Used by the integration test
// orchestration to block until Velocity's listener accepts connections
// on the host-mapped port (default 25577) before mocha is started.
//
// Usage:
//   node test/integration/wait-for-port.js [port] [host] [timeoutMs]
// Defaults: port=25577, host=127.0.0.1, timeoutMs=60000.
//
// Exit codes:
//   0  port responded within the timeout window
//   1  timed out
//   2  bad arguments

const net = require('net')

function parseInteger (raw, fallback, name) {
  if (raw === undefined) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`wait-for-port: invalid ${name} '${raw}'`)
    process.exit(2)
  }
  return n
}

const port = parseInteger(process.argv[2], 25577, 'port')
const host = process.argv[3] || '127.0.0.1'
const timeoutMs = parseInteger(process.argv[4], 60000, 'timeoutMs')

const probeIntervalMs = 1000
const probeTimeoutMs = 2000

const deadline = Date.now() + timeoutMs

function probeOnce () {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(probeTimeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

async function main () {
  process.stdout.write(`wait-for-port: polling ${host}:${port} (timeout ${timeoutMs}ms)\n`)
  while (Date.now() < deadline) {
    const ok = await probeOnce()
    if (ok) {
      const elapsed = timeoutMs - (deadline - Date.now())
      process.stdout.write(`wait-for-port: ${host}:${port} ready after ${elapsed}ms\n`)
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, probeIntervalMs))
  }
  console.error(`wait-for-port: timed out after ${timeoutMs}ms waiting for ${host}:${port}`)
  process.exit(1)
}

main().catch((err) => {
  console.error('wait-for-port: unexpected error', err)
  process.exit(1)
})
