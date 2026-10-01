/**
 * Host half of the General Settings connections card.
 *
 * Six routes on this composition's own `webServer` carry one sign-in from the
 * press of a button to a stored connection: the catalog, the start/answer/
 * cancel control plane, the disconnect action, and the provider redirect the
 * browser comes back on. Security keeps one home, exactly as the sibling
 * open-in-app routes do it: every control route asks `connection` for a
 * rejection first, so the Host/Origin fence and the browser-session cookie gate
 * callers before any credential is read or written. The callback route is the
 * exception and is fenced by the attempt's own unguessable `state` instead,
 * because the provider's redirect carries no session of ours.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'

import { ConnectError, ConnectionEngine, defaultOpenUrl, type ConnectionStore } from './engine.ts'

/** Absolute path prefix every route in this feature answers on. */
export const CONNECT_BASE_PATH = '/kairoforge/connect'

/** Request bodies here are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** The trust fence this feature borrows from the composition's connection service. */
interface ConnectionTrust {
  requestRejection(request: IncomingMessage): 401 | 403 | undefined
}

/** Read the connection service without importing its Host entry. */
function trustOf(ctx: Context): ConnectionTrust | undefined {
  return Reflect.get(ctx, 'connection') as ConnectionTrust | undefined
}

/** JSON response; connections are live facts, so nothing is cached. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the method the route actually supports. */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Decode a JSON object body, or throw the refusal the route should send. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') throw new ConnectError('content-type must be application/json', 'unsupported-media-type')
  const text = await readBoundedBody(req)
  if (text === null) throw new ConnectError('request body is too large', 'body-too-large')
  let decoded: unknown
  try { decoded = JSON.parse(text) } catch { throw new ConnectError('request body must be JSON', 'invalid-json') }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new ConnectError('request body must be a JSON object', 'invalid-body')
  }
  return decoded as Record<string, unknown>
}

/** One required string field of a request body. */
function field(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value === '') throw new ConnectError(`"${name}" is required`, 'missing-field')
  return value
}

/** This Host's browser origin as the caller reached it. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1:3080'
  const forwarded = req.headers['x-forwarded-proto']
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? 'http'
  return `${proto}://${host}`
}

/**
 * The credential store as the engine wants it: one opaque JSON payload per key.
 * @param ctx - the Host context carrying the credentials service.
 * @returns the store adapter.
 */
function storeOf(ctx: Context): ConnectionStore {
  const credentials = ctx.credentials
  const payloadOf = (record: CredentialRecord | undefined): unknown =>
    record !== undefined && record.kind === 'grant' ? record.payload : undefined
  return {
    read: async key => payloadOf(await credentials.readRecord(key as CredentialKey)),
    write: async (key, payload) => {
      await credentials.modifyRecord(key as CredentialKey, () => Promise.resolve({ kind: 'grant', payload }))
    },
    remove: async (key) => { await credentials.deleteRecord(key as CredentialKey) },
    keys: async () => (await credentials.listRecords()).map(entry => String(entry.key)),
  }
}

/**
 * Register the connection routes once the composition can serve them.
 * @param ctx - the plugin context.
 * @param options - test seams; production passes nothing.
 * @returns nothing; every route is owned by a Cordis effect.
 */
export function applyConnections(
  ctx: Context,
  options?: { readonly openUrl?: (url: string) => void; readonly engine?: ConnectionEngine },
): void {
  ctx.inject(['webServer', 'connection', 'credentials'], (scope) => {
    const engine = options?.engine ?? new ConnectionEngine({
      store: storeOf(scope),
      openUrl: options?.openUrl ?? defaultOpenUrl,
    })
    const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
      const rejection = trustOf(scope)?.requestRejection(req)
      if (rejection === undefined) return false
      res.statusCode = rejection
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return true
    }
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: CONNECT_BASE_PATH,
      handler: async (req, res) => {
        const pathname = new URL(String(req.url), 'http://localhost').pathname
        try {
          // The provider redirect carries no session cookie of ours; the attempt's
          // own unguessable state authenticates it instead of the trust fence.
          if (pathname === `${CONNECT_BASE_PATH}/callback`) {
            if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
            const url = new URL(String(req.url), originOf(req))
            const answer = engine.callback(url)
            if (answer === undefined) { sendJson(res, 404, { code: 'unknown-attempt', message: 'no sign-in is waiting for that state' }); return }
            res.statusCode = answer.status
            res.setHeader('content-type', 'text/html; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(answer.body)
            return
          }
          if (guard(req, res)) return
          await control(engine, req, res, pathname)
        } catch (error) {
          const failure = error instanceof ConnectError
            ? error
            : new ConnectError(error instanceof Error ? error.message : String(error), 'failed')
          sendJson(res, failure.code === 'unknown-service' || failure.code === 'unknown-attempt' ? 404 : 400,
            { code: failure.code, message: failure.message })
        }
      },
    }), 'ui-settings-general: connections routes')
  })
}

/** Dispatch one authenticated control request. */
async function control(
  engine: ConnectionEngine, req: IncomingMessage, res: ServerResponse, pathname: string,
): Promise<void> {
  const route = pathname.slice(CONNECT_BASE_PATH.length)
  if (route === '/catalog') {
    if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
    // `connection` is always present: an absent field and an explicit null mean
    // the same thing to the card, so the wire carries exactly one spelling.
    const services = (await engine.catalog()).map(service => ({ ...service, connection: service.connection ?? null }))
    sendJson(res, 200, {
      services,
      connectedCount: services.filter(service => service.connection !== null).length,
    })
    return
  }
  if (route === '/attempt') {
    if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
    const id = new URL(String(req.url), 'http://localhost').searchParams.get('id')
    if (id === null || id === '') throw new ConnectError('"id" is required', 'missing-field')
    const attempt = engine.view(id)
    if (attempt === undefined) throw new ConnectError('that sign-in attempt has expired', 'unknown-attempt')
    sendJson(res, 200, { attempt })
    return
  }
  if (route === '/start') {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    const body = await readJsonBody(req)
    const method = body.method
    sendJson(res, 200, {
      attempt: engine.start(field(body, 'service'), typeof method === 'string' && method !== '' ? method : undefined, originOf(req)),
    })
    return
  }
  if (route === '/answer') {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    const body = await readJsonBody(req)
    if (typeof body.value !== 'string') throw new ConnectError('"value" must be a string', 'missing-field')
    sendJson(res, 200, { attempt: engine.answer(field(body, 'id'), body.value) })
    return
  }
  if (route === '/cancel') {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    const body = await readJsonBody(req)
    sendJson(res, 200, { attempt: engine.cancel(field(body, 'id')) })
    return
  }
  if (route === '/disconnect') {
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    const body = await readJsonBody(req)
    const service = field(body, 'service')
    await engine.disconnect(service)
    sendJson(res, 200, { service, connection: null })
    return
  }
  sendJson(res, 404, { code: 'not-found', message: `no connections route ${route}` })
}
