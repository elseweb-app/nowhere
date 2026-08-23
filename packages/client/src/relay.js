// One relay endpoint, per SPEC.md sections 10-14 and 16: publishing an already-mined
// event, querying, and turning a rejection envelope into a typed outcome the pool can act
// on. What the relay says about itself — its policy and a key's standing — lives in
// discovery.js, because that is read on a different schedule and cached, while these are
// per-request traffic. `pool.js` composes many of these; nothing about a
// single relay's behavior differs from one relay inside a larger set — that symmetry is
// what keeps the multi-relay case from rotting.

import { safeParseEvent, safeParseErrorEnvelope } from '@elseweb/protocol'
import { createDiscovery } from './discovery.js'

const DEFAULT_QUERY_TIMEOUT_MS = 8000

// Mirrors the "Client action" column of SPEC.md section 16. Kept here, next to the
// parsing, so a rejection code and its action can never drift apart.
const REJECTION_ACTIONS = {
  UNSUPPORTED_VERSION: 'abandon',
  UNSUPPORTED_KIND: 'abandon_relay',
  SCHEMA_INVALID: 'abandon',
  PAYLOAD_TOO_LARGE: 'shrink_and_remine',
  STALE_TIMESTAMP: 'fix_clock_and_remine',
  SIGNATURE_INVALID: 'abandon',
  ATTESTATION_INVALID: 'refresh_attestation',
  ATTESTATION_REQUIRED: 'surface_to_user',
  POW_INSUFFICIENT: 'remine',
  QUOTA_EXCEEDED: 'wait',
}

export function actionForRejectionCode(code) {
  return REJECTION_ACTIONS[code] ?? 'abandon'
}

// A body that does not even parse as the error envelope shape is still turned into a
// typed outcome rather than thrown, so a hostile or broken relay can never take down a
// pool publish or read by raising past the caller.
function parseRejection(body, status) {
  const parsed = safeParseErrorEnvelope(body)
  if (!parsed.success) {
    return {
      code: 'UNKNOWN',
      message: `relay returned an unrecognized error shape (HTTP ${status})`,
      action: 'abandon',
    }
  }
  const { code, message, ...extra } = parsed.output.error
  return { code, message, action: actionForRejectionCode(code), ...extra }
}

export function createRelay({
  url,
  fetch: fetchImplementation,
  clock,
  readable = true,
  writable = true,
  policyTtlSeconds,
}) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('createRelay requires a url')
  }
  // fetch is the one platform global this package allows, and only because it exists
  // identically in a service worker, a SvelteKit page and a Capacitor WebView. It is
  // still taken as a parameter, never read off `globalThis`, so tests never touch a
  // network.
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('createRelay requires an injected fetch implementation')
  }
  if (!clock || typeof clock.now !== 'function') {
    throw new TypeError('createRelay requires an injected clock port')
  }

  function endpoint(path) {
    return url.endsWith('/') ? `${url.slice(0, -1)}${path}` : `${url}${path}`
  }

  const { getPolicy, getKeyStatus } = createDiscovery({
    url,
    endpoint,
    fetch: fetchImplementation,
    clock,
    policyTtlSeconds,
  })

  // Publishes an event that has already been mined and signed. Mining happens once, in
  // the pool, at the difficulty the whole writable set requires (SPEC.md section 12) —
  // a single relay never mines on its own, or "mine once" would be false by construction.
  async function publish(event) {
    let response
    try {
      response = await fetchImplementation(endpoint('/events'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      })
    } catch (cause) {
      return {
        relay: url,
        ok: false,
        code: 'NETWORK_ERROR',
        message: String(cause?.message ?? cause),
        action: 'retry_later',
      }
    }

    if (response.ok) {
      return { relay: url, ok: true, id: event.id }
    }

    let body = null
    try {
      body = await response.json()
    } catch {
      // A rejection with an unparseable body still becomes a typed UNKNOWN outcome
      // below, via parseRejection(null, status).
    }
    return { relay: url, ok: false, ...parseRejection(body, response.status) }
  }

  // Every readable-endpoint call goes through this: its own AbortController, its own
  // timeout, and it never throws. One relay being slow, down, or hostile must never
  // fail a read from the others (SPEC.md section 12).
  async function query(path, params, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS)
    try {
      const search = params ? `?${new URLSearchParams(params).toString()}` : ''
      const response = await fetchImplementation(endpoint(`${path}${search}`), {
        signal: controller.signal,
      })
      if (!response.ok) {
        return { relay: url, ok: false, events: [] }
      }
      const body = await response.json()
      const rawEvents = Array.isArray(body?.events) ? body.events : []
      // A relay is untrusted input. Anything it returns that does not match the event
      // schema is dropped here rather than handed further into the client.
      const events = rawEvents
        .map((rawEvent) => safeParseEvent(rawEvent))
        .filter((result) => result.success)
        .map((result) => result.output)
      return { relay: url, ok: true, events }
    } catch {
      return { relay: url, ok: false, events: [] }
    } finally {
      clearTimeout(timer)
    }
  }

  function queryPage({ pageId, anchorId, timeoutMs } = {}) {
    const params = { page_id: pageId }
    if (anchorId) params.anchor_id = anchorId
    return query('/events', params, timeoutMs)
  }

  function queryVotes({ targetId, timeoutMs } = {}) {
    return query('/events', { target_id: targetId }, timeoutMs)
  }

  function queryFeed({ cursor, timeoutMs } = {}) {
    return query('/feed', cursor ? { cursor } : undefined, timeoutMs)
  }

  return {
    url,
    readable,
    writable,
    getPolicy,
    publish,
    queryPage,
    queryVotes,
    queryFeed,
    getKeyStatus,
  }
}
