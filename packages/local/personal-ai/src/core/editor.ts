/**
 * Editor awareness. The KairoForge editor extension (VS Code / Cursor) reports
 * what the user is looking at: the active file, cursor, selection, the code
 * around the cursor, open tabs, and the editor's own diagnostics. This module
 * turns one report into prompt context. Secrets never pass through: secret
 * files keep only their path, and excerpts are redacted.
 */
import { redact } from '@local/main-agents'
import { isSecretPath } from './risk.ts'

/** One editor diagnostic (problem). */
export interface EditorDiagnostic {
  readonly file: string
  /** 1-based line. */
  readonly line: number
  readonly severity: 'error' | 'warning' | 'info' | 'hint'
  readonly message: string
  readonly source?: string
}

/** What the editor reported. Lines are 1-based. */
export interface EditorSnapshot {
  /** Editor product, e.g. "Cursor" or "Visual Studio Code". */
  readonly editor: string
  readonly workspaceFolders: readonly string[]
  readonly activeFile?: string
  readonly language?: string
  readonly cursor?: { readonly line: number; readonly column: number }
  readonly selection?: { readonly startLine: number; readonly endLine: number; readonly text: string }
  /** Lines around the cursor, starting at `startLine`. */
  readonly excerpt?: { readonly startLine: number; readonly text: string }
  readonly dirty?: boolean
  readonly openFiles: readonly string[]
  readonly diagnostics: readonly EditorDiagnostic[]
  /** ISO time the editor sent it. */
  readonly at: string
}

/** Reports older than this are not used as context. */
export const EDITOR_FRESH_MS = 15 * 60_000
const SELECTION_CHARS = 4000
const EXCERPT_CHARS = 6000
const OPEN_FILES = 15
const DIAGNOSTICS = 15
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const SEVERITY_RANK: Readonly<Record<EditorDiagnostic['severity'], number>> = { error: 0, warning: 1, info: 2, hint: 3 }

/**
 * Remove secrets from editor text.
 * @param text - selection or excerpt.
 * @returns the text with tokens and private keys replaced.
 */
export function scrubEditorText(text: string): string {
  return redact(text.replaceAll(PRIVATE_KEY_BLOCK, '[private key removed]'))
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${String(text.length - max)} more characters)`
}

/**
 * Make a report safe to keep: secret files lose their contents, text is
 * scrubbed, and sizes are capped.
 * @param snapshot - raw report from the extension.
 * @returns the report KairoForge stores.
 */
export function sanitizeSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  const secret = snapshot.activeFile !== undefined && isSecretPath(snapshot.activeFile)
  const { selection, excerpt, ...rest } = snapshot
  return {
    ...rest,
    openFiles: snapshot.openFiles.slice(0, 50),
    diagnostics: snapshot.diagnostics.slice(0, 200).map(item => ({ ...item, message: scrubEditorText(item.message).slice(0, 500) })),
    ...selection === undefined || secret
      ? {}
      : { selection: { ...selection, text: clip(scrubEditorText(selection.text), SELECTION_CHARS) } },
    ...excerpt === undefined || secret ? {} : { excerpt: { ...excerpt, text: clip(scrubEditorText(excerpt.text), EXCERPT_CHARS) } },
  }
}

function relative(path: string, roots: readonly string[]): string {
  for (const root of roots) {
    if (path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  }
  return path
}

function numbered(startLine: number, text: string, mark?: number): string {
  return text.split('\n').map((line, index) => {
    const number = startLine + index
    return `${number === mark ? '>' : ' '}${String(number).padStart(5)}| ${line}`
  }).join('\n')
}

/**
 * Prompt context describing the user's editor.
 * @param snapshot - latest sanitized report.
 * @param now - current time in ms.
 * @returns context text, or '' when there is no fresh report.
 */
export function editorContextText(snapshot: EditorSnapshot | undefined, now: number): string {
  if (snapshot === undefined) return ''
  const age = now - Date.parse(snapshot.at)
  if (!Number.isFinite(age) || age > EDITOR_FRESH_MS) return ''
  const roots = snapshot.workspaceFolders
  const lines = [`The user's editor (${snapshot.editor}, ${age < 60_000 ? 'live' : `${String(Math.round(age / 60_000))} min ago`}). "This file", "here", or "this error" refer to it.`]
  if (roots.length > 0) lines.push(`Workspace: ${roots.join(', ')}`)
  if (snapshot.activeFile !== undefined) {
    const where = snapshot.cursor === undefined ? '' : `, cursor at line ${String(snapshot.cursor.line)} col ${String(snapshot.cursor.column)}`
    lines.push(`Active file: ${snapshot.activeFile}${snapshot.language === undefined ? '' : ` (${snapshot.language})`}${where}${snapshot.dirty === true ? ', unsaved changes' : ''}`)
  }
  if (snapshot.selection !== undefined && snapshot.selection.text.trim() !== '') {
    lines.push(`Selected lines ${String(snapshot.selection.startLine)}-${String(snapshot.selection.endLine)}:`, '```', snapshot.selection.text, '```')
  } else if (snapshot.excerpt !== undefined && snapshot.excerpt.text.trim() !== '') {
    lines.push('Code around the cursor (">" marks the cursor line; may differ from disk if unsaved):', '```', numbered(snapshot.excerpt.startLine, snapshot.excerpt.text, snapshot.cursor?.line), '```')
  }
  const diagnostics = [...snapshot.diagnostics]
    .filter(diagnostic => diagnostic.severity === 'error' || diagnostic.severity === 'warning')
    .sort((a, b) => Number(b.file === snapshot.activeFile) - Number(a.file === snapshot.activeFile)
      || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, DIAGNOSTICS)
  if (diagnostics.length > 0) {
    lines.push('Editor problems:')
    for (const diagnostic of diagnostics) {
      lines.push(`- ${diagnostic.severity} ${relative(diagnostic.file, roots)}:${String(diagnostic.line)} ${diagnostic.message}${diagnostic.source === undefined ? '' : ` [${diagnostic.source}]`}`)
    }
  }
  const others = snapshot.openFiles.filter(file => file !== snapshot.activeFile).slice(0, OPEN_FILES)
  if (others.length > 0) lines.push(`Other open tabs: ${others.map(file => relative(file, roots)).join(', ')}`)
  return lines.join('\n')
}
