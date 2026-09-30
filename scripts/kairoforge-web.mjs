#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { networkInterfaces } from 'node:os'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, '..')
const port = process.env.KAIROFORGE_PORT ?? '3080'
const host = process.env.KAIROFORGE_HOST ?? '0.0.0.0'
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()

const lanAddresses = Object.values(networkInterfaces()).flat()
  .filter(iface => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
  .map(iface => iface.address)
const primaryLanUrl = lanAddresses.length > 0 ? `http://${lanAddresses[0]}:${port}` : undefined

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--host', host, '--port', port, ...lanAddresses.flatMap(address => ['--trusted-host', address]), ...args],
  {
    cwd: rootDir,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  },
)

const rewrite = (chunk) => {
  const text = chunk.toString()
    .replaceAll('dsh web:', 'KairoForge:')
    .replaceAll('dsh:', 'KairoForge:')
    .replaceAll('DeepSeek Harness', 'KairoForge')
  return text
}

process.stdout.write(`Starting KairoForge at http://127.0.0.1:${port}\n`)
if (primaryLanUrl !== undefined) {
  process.stdout.write(`Phone Connect URL: ${primaryLanUrl}\n`)
  process.stdout.write(`Use this from a phone on the same Wi-Fi after KairoForge prints its token URL.\n`)
} else {
  process.stdout.write(`Phone Connect: no Wi-Fi/LAN address found yet; connect your Mac to Wi-Fi and restart.\n`)
}
process.stdout.write(`Tip: set KAIROFORGE_PORT=3090 to use a different port.\n`)
process.stdout.write(`Tip: set KAIROFORGE_HOST=127.0.0.1 for computer-only mode.\n`)

child.stdout.on('data', chunk => process.stdout.write(rewrite(chunk)))
child.stderr.on('data', chunk => process.stderr.write(rewrite(chunk)))

const forward = (signal) => {
  if (!child.killed) child.kill(signal)
}

process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))

child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})
