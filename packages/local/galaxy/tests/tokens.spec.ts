import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve(import.meta.dirname, '../scripts/check-tokens.mjs')

describe('check-tokens', () => {
  it('passes on the demo UI', () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('rejects colours written outside tokens.css', () => {
    const dir = mkdtempSync(join(tmpdir(), 'galaxy-tokens-'))
    try {
      writeFileSync(join(dir, 'tokens.css'), ':root { --ok: #123456; }\n')
      writeFileSync(join(dir, 'panel.css'), '.panel { color: #fff; }\n')
      writeFileSync(join(dir, 'panel.ts'), "element.style.color = 'rgb(1 2 3)'\nquery('#stage')\n")
      const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('panel.css:1: #fff')
      expect(result.stderr).toContain("panel.ts:1: 'rgb(")
      expect(result.stderr).not.toContain('tokens.css:')
      expect(result.stderr).not.toContain('#stage')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
