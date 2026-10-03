/**
 * Fast syntax checks after the agent edits a file, so a broken edit is caught
 * in the same step instead of at the next build. Each check is parse-only (no
 * type checking, no code runs) and bounded by a short timeout.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** Outcome of one check. */
export type SyntaxResult = { readonly ok: true; readonly checker: string } | {
  readonly ok: false
  readonly checker: string
  readonly line?: number
  readonly message: string
}

const TIMEOUT_MS = 8000
const MAX_BYTES = 2 * 1024 * 1024
const PYTHON_PARSE = 'import ast,sys\nsrc=open(sys.argv[1],encoding="utf-8").read()\nast.parse(src,sys.argv[1])'

type TypeScriptModule = typeof import('typescript')
let typescript: Promise<TypeScriptModule | undefined> | undefined

function loadTypeScript(): Promise<TypeScriptModule | undefined> {
  typescript ??= import('typescript').then(module => (module as { default?: TypeScriptModule }).default ?? module).catch(() => undefined)
  return typescript
}

function run(command: string, args: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, output: `${stderr}${stdout}`.trim() })
    })
  })
}

function firstLine(output: string, pattern: RegExp): number | undefined {
  const line = pattern.exec(output)?.[1]
  return line === undefined ? undefined : Number(line)
}

function jsonLine(text: string, message: string): number | undefined {
  const position = /position (\d+)/.exec(message)?.[1]
  if (position === undefined) return firstLine(message, /line (\d+)/)
  return text.slice(0, Number(position)).split('\n').length
}

async function checkTypeScript(path: string, text: string): Promise<SyntaxResult | undefined> {
  const ts = await loadTypeScript()
  if (ts === undefined) return undefined
  const output = ts.transpileModule(text, { fileName: path, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve } })
  const first = output.diagnostics?.find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
  if (first === undefined) return { ok: true, checker: 'typescript' }
  const { file, start } = first
  const line = file === undefined || start === undefined ? undefined : file.getLineAndCharacterOfPosition(start).line + 1
  return { ok: false, checker: 'typescript', ...line === undefined ? {} : { line }, message: ts.flattenDiagnosticMessageText(first.messageText, ' ') }
}

/**
 * Parse-check one file by its extension.
 * @param path - absolute file path.
 * @returns the result, or undefined when there is no checker for this file type.
 */
export async function checkSyntax(path: string): Promise<SyntaxResult | undefined> {
  const extension = extname(path).slice(1).toLowerCase()
  if (!/^(?:json|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|sh|bash|zsh)$/.test(extension)) return undefined
  if (/(?:^|\/)(?:tsconfig[^/]*|jsconfig[^/]*|\.eslintrc[^/]*|devcontainer)\.json$/i.test(path)) return undefined
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined || text.length > MAX_BYTES) return undefined
  switch (extension) {
    case 'json': {
      try {
        JSON.parse(text)
        return { ok: true, checker: 'json' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const line = jsonLine(text, message)
        return { ok: false, checker: 'json', ...line === undefined ? {} : { line }, message }
      }
    }
    case 'ts': case 'tsx': case 'mts': case 'cts': case 'jsx':
      return checkTypeScript(path, text)
    case 'js': case 'mjs': case 'cjs': {
      const { code, output } = await run(process.execPath, ['--check', path])
      if (code === 0) return { ok: true, checker: 'node --check' }
      const line = firstLine(output, /:(\d+)\n/)
      return { ok: false, checker: 'node --check', ...line === undefined ? {} : { line }, message: output.split('\n').find(row => /Error/.test(row)) ?? output.slice(0, 300) }
    }
    case 'py': {
      const { code, output } = await run('python3', ['-c', PYTHON_PARSE, path])
      if (code === 0) return { ok: true, checker: 'python ast' }
      if (/command not found|ENOENT/.test(output)) return undefined
      const line = [...output.matchAll(/line (\d+)/g)].map(match => Number(match[1])).pop()
      return { ok: false, checker: 'python ast', ...line === undefined ? {} : { line }, message: output.split('\n').filter(row => row.trim() !== '').pop() ?? output }
    }
    default: {
      const shell = extension === 'zsh' ? '/bin/zsh' : '/bin/bash'
      const { code, output } = await run(shell, ['-n', path])
      if (code === 0) return { ok: true, checker: `${shell} -n` }
      const line = firstLine(output, /line (\d+)/) ?? firstLine(output, /:(\d+):/)
      return { ok: false, checker: `${shell} -n`, ...line === undefined ? {} : { line }, message: output.slice(0, 300) }
    }
  }
}

/**
 * The note appended to an edit result when the file no longer parses.
 * @param path - file path shown to the model.
 * @param result - failed check.
 * @returns guidance text.
 */
export function syntaxWarning(path: string, result: Extract<SyntaxResult, { ok: false }>): string {
  const where = result.line === undefined ? '' : ` at line ${String(result.line)}`
  return `Syntax check (${result.checker}) FAILED for ${path}${where}: ${result.message}\n`
    + 'The edit was saved but the file no longer parses. Read the lines around the error and fix it before doing anything else.'
}
