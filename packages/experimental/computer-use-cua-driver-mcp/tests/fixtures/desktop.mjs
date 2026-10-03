/** External stdio fixture with structured window results and an agent cursor; it never touches the host desktop. */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const root = process.argv[2]
const record = (name, args) => appendFileSync(join(root, 'calls.ndjson'), JSON.stringify({ name, args }) + '\n')
const tool = (name, properties = {}) => ({ name, description: name, inputSchema: { type: 'object', properties } })
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'desktop-fixture', version: '1.0.0' } }
      break
    case 'tools/list':
      result = { tools: [tool('list_windows', { pid: { type: 'integer' } }), tool('click', { element_token: { type: 'string' } }), tool('set_agent_cursor_enabled', { enabled: { type: 'boolean' } })] }
      break
    case 'tools/call':
      record(request.params.name, request.params.arguments)
      result = request.params.name === 'list_windows'
        ? { content: [{ type: 'text', text: 'Found 1 window(s).' }], structuredContent: { _note: 'prefer windows', windows: [{ window_id: 2368, title: 'Untitled' }] } }
        : { content: [{ type: 'text', text: 'ok' }] }
      break
    default:
      result = {}
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})
