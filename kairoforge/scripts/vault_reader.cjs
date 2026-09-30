#!/usr/bin/env node
/**
 * Read dsh session logs into plain conversation records.
 *
 * Session logs are concatenated Zstandard frames: one frame per appended
 * batch. Node's one-shot `zstdDecompressSync` stops at the first frame, which
 * is why a 1.6 MB log appears to contain a single event. This walks the frame
 * boundaries structurally (the same algorithm the harness's own
 * `session-persistence-jsonl` backend uses) and decompresses each frame
 * independently.
 *
 * Output is newline-delimited JSON, one conversation message per line, which
 * is what the vault indexer consumes.
 *
 * Usage:
 *   node vault_reader.js --sessions <dir> --out <file.jsonl>
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { zstdDecompressSync } = require('node:zlib')

const ZSTD_MAGIC = 0xFD2FB528

/**
 * Split a concatenated Zstandard stream into complete frames.
 *
 * Mirrors the harness's scanner: a frame is located purely from its header
 * and block structure, so no decompression happens until the boundaries are
 * known.
 *
 * @param {Buffer} buffer - complete bytes of the session artifact.
 * @returns {{start:number,end:number}[]} complete frame ranges.
 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4

    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remaining) break
    offset += remaining

    let torn = false
    for (;;) {
      if (buffer.length - offset < 3) { torn = true; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { torn = true; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (torn) break

    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  return frames
}

/**
 * Decode one session file into its raw JSONL text.
 *
 * A frame that fails to decompress is skipped rather than aborting the whole
 * session: a torn final frame is expected when a session is currently being
 * written.
 *
 * @param {string} file - path to session.v4.jsonl.zstd.
 * @returns {string} concatenated decoded text.
 */
function decodeSession(file) {
  const buffer = fs.readFileSync(file)
  const frames = scanFrames(buffer)
  const parts = []
  for (const frame of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    } catch {
      // A frame we cannot read is skipped; the rest of the log is still usable.
    }
  }
  return parts.join('')
}

/**
 * Pull plain user/assistant text out of one decoded session event.
 *
 * Event shapes vary by version, so this searches for message content rather
 * than asserting one exact schema: anything carrying a role and text is
 * captured, and everything else is ignored.
 *
 * @param {any} event - one parsed JSONL event.
 * @returns {{role:string,text:string}[]} extracted messages.
 */
function extractMessages(event) {
  const found = []

  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }

    const role = node.role
    if (typeof role === 'string' && (role === 'user' || role === 'assistant')) {
      const text = textOf(node.content)
      if (text) found.push({ role, text })
    }

    for (const key of Object.keys(node)) {
      if (key === 'content' || key === 'text') continue
      visit(node[key], depth + 1)
    }
  }

  visit(event, 0)
  return found
}

/**
 * Flatten a content value to plain text.
 *
 * Content may be a string or an array of typed blocks; tool-call and
 * reasoning blocks are skipped because the vault stores conversation, and a
 * tool call is not something either party said.
 *
 * @param {any} content - message content.
 * @returns {string} plain text, empty when there is none.
 */
function textOf(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function main() {
  const args = process.argv.slice(2)
  const get = (flag, fallback) => {
    const i = args.indexOf(flag)
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback
  }

  const sessionsDir = get('--sessions', path.join(process.env.HOME, '.dsh/sessions'))
  const outPath = get('--out', '')

  const out = []
  const stats = { sessions: 0, events: 0, messages: 0, skipped: 0 }

  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.jsonl.zstd')) continue

      const sessionId = path.basename(path.dirname(full))
      let text
      try { text = decodeSession(full) } catch { stats.skipped++; continue }
      stats.sessions++

      let index = 0
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        stats.events++
        for (const message of extractMessages(event)) {
          if (message.text.length < 2) continue
          out.push(JSON.stringify({
            session: sessionId,
            role: message.role,
            text: message.text,
            index: index++,
          }))
          stats.messages++
        }
      }
    }
  }

  walk(sessionsDir)

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, out.join('\n') + (out.length ? '\n' : ''), 'utf8')
  }

  console.error(JSON.stringify(stats))
  if (!outPath) process.stdout.write(out.join('\n'))
}

main()
