#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, '..')
const port = process.env.KAIROFORGE_PORT ?? '3080'
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', port, ...args],
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
process.stdout.write(`Tip: set KAIROFORGE_PORT=3090 to use a different port.\n`)

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
