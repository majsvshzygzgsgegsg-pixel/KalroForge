#!/usr/bin/env node
// Fails when a UI colour is written anywhere but a tokens.css file.
// Usage: node scripts/check-tokens.mjs [dir...]   (default: the demo)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dirs = process.argv.length > 2 ? process.argv.slice(2).map(dir => resolve(dir)) : [join(root, 'demo')]

const CSS_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/giu
const SCRIPT_COLOR = /['"`]#[0-9a-f]{3,8}['"`]|['"`](?:rgba?|hsla?|oklch)\(/giu
const SCRIPT_EXT = /\.(?:[cm]?[jt]sx?|html)$/u

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* files(path)
    else yield path
  }
}

const violations = []
for (const dir of dirs) {
  for (const path of files(dir)) {
    if (path.endsWith('tokens.css')) continue
    const pattern = path.endsWith('.css') ? CSS_COLOR : SCRIPT_EXT.test(path) ? SCRIPT_COLOR : undefined
    if (pattern === undefined) continue
    const lines = readFileSync(path, 'utf8').split('\n')
    lines.forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        violations.push(`${relative(process.cwd(), path)}:${index + 1}: ${match[0]}`)
      }
    })
  }
}

if (violations.length > 0) {
  console.error(`Colours must live in tokens.css (${violations.length} found):`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log('tokens: ok')
